#!/usr/bin/env node --no-warnings

import { program } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Simple line-by-line diff function for lightweight version
function getSimpleDiff(oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLines = Math.max(oldLines.length, newLines.length);
  const diffLines = [];

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";
    if (oldLine !== newLine) {
      if (oldLine.trim() === "" && newLine.trim() === "") {
        // Both empty, skip to reduce noise
        continue;
      }
      diffLines.push(`- ${oldLine}`);
      diffLines.push(`+ ${newLine}`);
    }
  }

  return diffLines.join("\n");
}

program
  .name("coding-agent")
  .description(
    "A lightweight file-based coding agent that creates file structures",
  )
  .version("0.1.0");

program
  .command("run <task>")
  .description(
    "Run a task and create files as needed in the ./generated directory",
  )
  .option("-f, --force", "Overwrite existing files without asking")
  .action((task, options) => {
    console.log(`🚀 Processing task: ${task}`);

    // Define file templates for known tasks
    const fileTemplates = {
      // Node.js login backend
      "create a nodejs backend for a login page please": {
        "server.js": `const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', require('./routes/auth'));

app.get('/api/health', (req, res) => {
  res.json({ message: 'Server is running', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err : {}
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});`,
        "package.json": `{
  "name": "node-login-backend",
  "version": "1.0.0",
  "description": "Node.js backend for login page with JWT authentication",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.0",
    "bcryptjs": "^2.4.3",
    "dotenv": "^16.0.3",
    "express-validator": "^6.15.0",
    "cors": "^2.8.5",
    "helmet": "^7.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  },
  "keywords": ["node", "express", "jwt", "authentication", "login"],
  "author": "",
  "license": "MIT"
}`,
        ".env.example":
          "# Server Configuration\nPORT=5000\nNODE_ENV=development\n\n# JWT Configuration\nJWT_SECRET=your_super_secret_jwt_key_change_this_in_production\nJWT_EXPIRE=7d\n\n# Database (optional - for demo we use in-memory)\n# MONGODB_URI=mongodb://localhost:27017/login_demo",
        ".gitignore":
          "# Dependencies\nnode_modules/\n\n# Environment variables\n.env\n\n# Logs\nnpm-debug.log\n\n# OS files\n.DS_Store\nThumbs.db\n\n# IDE\n.vscode/\n.idea/\n*.swp\n*.swo\n",
        "README.md":
          '# Node.js Login Backend\n\nA secure Node.js REST API for user authentication with JWT tokens.\n\n## Features\n- User registration & login\n- Password hashing with bcrypt\n- JWT authentication\n- Input validation\n- In-memory storage (easy to switch to MongoDB)\n\n## Quick Start\n\n1. Install dependencies:\n   ```bash\n   npm install\n   ```\n\n2. Copy `.env.example` to `.env` and edit:\n   ```bash\n   cp .env.example .env\n   ```\n\n3. Start the server:\n   ```bash\n   npm run dev\n   ```\n\nServer runs on http://localhost:5000\n\n## Test API\n\n**Register:**\n```bash\ncurl -X POST http://localhost:5000/api/auth/register \\\n  -H "Content-Type: application/json" \\\n  -d \'{"email":"test@example.com","password":"password123","name":"Test User"}\'\n```\n\n**Login:**\n```bash\ncurl -X POST http://localhost:5000/api/auth/login \\\n  -H "Content-Type: application/json" \\\n  -d \'{"email":"test@example.com","password":"password123"}\'\n```\n\n**Get Profile:** (use token from login)\n```bash\ncurl http://localhost:5000/api/auth/me \\\n  -H "Authorization: Bearer YOUR_TOKEN"\n```\n\nSee README.md for full documentation.',
        "config/database.js":
          "// Database configuration (optional for demo)\n// For this demo, we'll use in-memory storage\n// Uncomment and configure for MongoDB\n\n// const mongoose = require('mongoose');\n\n// module.exports = async () => {\n//   try {\n//     await mongoose.connect(process.env.MONGODB_URI, {\n//       useNewUrlParser: true,\n//       useUnifiedTopology: true,\n//     });\n//     console.log('MongoDB connected');\n//   } catch (error) {\n//     console.error('MongoDB connection error:', error);\n//     // Continue without database for demo\n//   }\n// };\n\nmodule.exports = () => {\n  console.log('Running in in-memory mode (no database)');\n};",
        "controllers/authController.js":
          "const jwt = require('jsonwebtoken');\nconst bcrypt = require('bcryptjs');\n\nconst users = [];\nlet idCounter = 1;\n\nconst generateToken = (id) => {\n  return jwt.sign({ id }, process.env.JWT_SECRET, {\n    expiresIn: process.env.JWT_EXPIRE || '7d'\n  });\n};\n\n// @desc    Register user\n// @route   POST /api/auth/register\n// @access  Public\nconst register = async (req, res, next) => {\n  try {\n    const { email, password, name } = req.body;\n\n    // Check if user exists\n    const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());\n    if (existingUser) {\n      return res.status(400).json({ success: false, message: 'User already exists' });\n    }\n\n    // Create user\n    const salt = await bcrypt.genSalt(10);\n    const hashedPassword = await bcrypt.hash(password, salt);\n    \n    const user = {\n      _id: String(idCounter++),\n      email: email.toLowerCase(),\n      password: hashedPassword,\n      name,\n      isActive: true,\n      createdAt: new Date()\n    };\n\n    users.push(user);\n\n    // Create token\n    const token = generateToken(user._id);\n    \n    // Remove password from output\n    user.password = undefined;\n\n    res.status(201).json({ success: true, token, user });\n  } catch (error) {\n    next(error);\n  }\n};\n\n// @desc    Login user\n// @route   POST /api/auth/login\n// @access  Public\nconst login = async (req, res, next) => {\n  try {\n    const { email, password } = req.body;\n\n    // Validate email and password\n    if (!email || !password) {\n      return res.status(400).json({ success: false, message: 'Please provide email and password' });\n    }\n\n    // Check for user\n    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());\n\n    if (!user) {\n      return res.status(401).json({ success: false, message: 'Invalid credentials' });\n    }\n\n    // Check password\n    const isMatch = await bcrypt.compare(password, user.password);\n\n    if (!isMatch) {\n      return res.status(401).json({ success: false, message: 'Invalid credentials' });\n    }\n\n    // Check if account is active\n    if (!user.isActive) {\n      return res.status(401).json({ success: false, message: 'Account is deactivated' });\n    }\n\n    // Update last login\n    user.lastLogin = Date.now();\n    const token = generateToken(user._id);\n    \n    // Remove password from output\n    user.password = undefined;\n\n    res.status(200).json({ success: true, token, user });\n  } catch (error) {\n    next(error);\n  }\n};\n\n// @desc    Get current user profile\n// @route   GET /api/auth/me\n// @access  Private\nconst getMe = async (req, res, next) => {\n  try {\n    const user = users.find(u => u._id === req.user.id);\n    \n    if (!user) {\n      return res.status(404).json({ success: false, message: 'User not found' });\n    }\n    \n    user.password = undefined;\n    res.status(200).json({ success: true, user });\n  } catch (error) {\n    next(error);\n  }\n};\n\n// @desc    Protect middleware\n// @route   \n// @access  Private\nconst protect = async (req, res, next) => {\n  let token;\n\n  // Check for token in headers\n  if (\n    req.headers.authorization &&\n    req.headers.authorization.startsWith('Bearer')\n  ) {\n    token = req.headers.authorization.split(' ')[1];\n  }\n\n  // Check if token exists\n  if (!token) {\n    return res.status(401).json({ success: false, message: 'Not authorized to access this route' });\n  }\n\n  try {\n    // Verify token\n    const decoded = jwt.verify(token, process.env.JWT_SECRET);\n    \n    // Check if user still exists\n    const user = users.find(u => u._id === decoded.id);\n    if (!user) {\n      return res.status(401).json({ success: false, message: 'User no longer exists' });\n    }\n\n    // Add user to request object\n    req.user = user;\n    next();\n  } catch (error) {\n    if (error.name === 'JsonWebTokenError') {\n      return res.status(401).json({ success: false, message: 'Invalid token' });\n    }\n    if (error.name === 'TokenExpiredError') {\n      return res.status(401).json({ success: false, message: 'Token expired' });\n    }\n    next(error);\n  }\n};\n\nmodule.exports = {\n  register,\n  login,\n  getMe,\n  protect\n};",
        "routes/auth.js":
          "const express = require('express');\nconst router = express.Router();\nconst { body } = require('express-validator');\nconst authController = require('../controllers/authController');\n\n// Validation rules\nconst registerValidation = [\n  body('email')\n    .isEmail().normalizeEmail().withMessage('Please enter a valid email'),\n  body('password')\n    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),\n  body('name')\n    .trim().notEmpty().withMessage('Name is required')\n];\n\nconst loginValidation = [\n  body('email')\n    .isEmail().normalizeEmail().withMessage('Please enter a valid email'),\n  body('password')\n    .notEmpty().withMessage('Password is required')\n];\n\n// Routes\nrouter.post('/register', registerValidation, authController.register);\nrouter.post('/login', loginValidation, authController.login);\nrouter.get('/me', authController.protect, authController.getMe);\n\nmodule.exports = router;",
      },
    };

    // Check if we have a file template for this task
    const template = fileTemplates[task.toLowerCase()];

    if (template) {
      // We have a multi-file template
      const outputDir = join(process.cwd(), "generated");
      console.log(`📁 Output directory: ${outputDir}`);

      // Create output directory if it doesn't exist
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
        console.log(`📁 Created directory: ${outputDir}`);
      }

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      for (const [relativeFilePath, content] of Object.entries(template)) {
        const filePath = join(outputDir, relativeFilePath);
        const dirName = dirname(filePath);

        // Ensure the directory exists
        if (!existsSync(dirName)) {
          mkdirSync(dirName, { recursive: true });
        }

        if (existsSync(filePath)) {
          if (options.force) {
            // Read old content for diff
            const oldContent = readFileSync(filePath, "utf8");
            // Write new content
            writeFileSync(filePath, content, "utf8");
            // Show diff
            const diff = getSimpleDiff(oldContent, content);
            if (diff.trim() !== "") {
              console.log(`🔄 Overwrote: ${relativeFilePath}`);
              console.log(`\nDiff:\n${diff}\n`);
            } else {
              console.log(`🔄 Overwrote (no changes): ${relativeFilePath}`);
            }
            updatedCount++;
          } else {
            skippedCount++;
            console.log(
              `⏭️  Skipped (exists, use --force to overwrite): ${relativeFilePath}`,
            );
          }
        } else {
          writeFileSync(filePath, content, "utf8");
          createdCount++;
          console.log(`📄 Created: ${relativeFilePath}`);
        }
      }

      console.log(`\n✅ Summary:`);
      console.log(`   Created: ${createdCount} files`);
      console.log(`   Updated: ${updatedCount} files`);
      console.log(`   Skipped: ${skippedCount} files`);
      console.log(
        `   Total: ${createdCount + updatedCount + skippedCount} files`,
      );
      console.log(`\n📁 Files created in: ${outputDir}`);
    } else {
      // Fall back to the old template-based response for simple tasks
      const taskLower = task.toLowerCase();

      // Simple template-based responses for common tasks
      if (taskLower.includes("hello world") && taskLower.includes("function")) {
        if (taskLower.includes("python")) {
          console.log("\nHere is a simple hello world function in Python:\n");
          console.log("def hello_world():");
          console.log('    return "Hello, World!"\n');
        } else if (
          taskLower.includes("javascript") ||
          taskLower.includes("js") ||
          taskLower.includes("node")
        ) {
          console.log(
            "\nHere is a simple hello world function in JavaScript:\n",
          );
          console.log("function helloWorld() {");
          console.log('  return "Hello, World!";');
          console.log("}\n");
        } else {
          // Default to JavaScript
          console.log("\nHere is a simple hello world function:\n");
          console.log("function helloWorld() {");
          console.log('  return "Hello, World!";');
          console.log("}\n");
        }
      }
      // Factorial function
      else if (
        taskLower.includes("factorial") &&
        taskLower.includes("function")
      ) {
        if (taskLower.includes("python")) {
          console.log("\nHere is a factorial function in Python:\n");
          console.log("def factorial(n):");
          console.log("    if n < 0:");
          console.log(
            '        raise ValueError("Factorial is not defined for negative numbers")',
          );
          console.log("    if n == 0 or n == 1:");
          console.log("        return 1");
          console.log("    return n * factorial(n - 1)\n");
        } else if (
          taskLower.includes("javascript") ||
          taskLower.includes("js") ||
          taskLower.includes("node")
        ) {
          console.log("\nHere is a factorial function in JavaScript:\n");
          console.log("function factorial(n) {");
          console.log("  if (n < 0) {");
          console.log(
            '    throw new Error("Factorial is not defined for negative numbers");',
          );
          console.log("  }");
          console.log("  if (n === 0 || n === 1) {");
          console.log("    return 1;");
          console.log("  }");
          console.log("  return n * factorial(n - 1);");
          console.log("}\n");
        } else {
          // Default to JavaScript
          console.log("\nHere is a factorial function in JavaScript:\n");
          console.log("function factorial(n) {");
          console.log("  if (n < 0) {");
          console.log(
            '    throw new Error("Factorial is not defined for negative numbers");',
          );
          console.log("  }");
          console.log("  if (n === 0 || n === 1) {");
          console.log("    return 1;");
          console.log("  }");
          console.log("  return n * factorial(n - 1);");
          console.log("}\n");
        }
      }
      // Simple HTML page
      else if (taskLower.includes("html") && taskLower.includes("page")) {
        console.log("\nHere is a simple HTML page:\n");
        console.log("<!DOCTYPE html>");
        console.log('<html lang="en">');
        console.log("<head>");
        console.log('    <meta charset="UTF-8">');
        console.log(
          '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        );
        console.log("    <title>Simple Page</title>");
        console.log("</head>");
        console.log("<body>");
        console.log("    <h1>Welcome to My Page</h1>");
        console.log("    <p>This is a simple HTML page.</p>");
        console.log("</body>");
        console.log("</html>\n");
      }
      // Basic CSS reset
      else if (
        taskLower.includes("css") &&
        (taskLower.includes("reset") || taskLower.includes("reset.css"))
      ) {
        console.log("\nHere is a basic CSS reset:\n");
        console.log("/* Basic CSS Reset */");
        console.log("* {");
        console.log("  margin: 0;");
        console.log("  padding: 0;");
        console.log("  box-sizing: border-box;");
        console.log("}");
        console.log("html, body {");
        console.log("  height: 100%;");
        console.log("}");
        console.log("body {");
        console.log("  line-height: 1.6;");
        console.log("  font-family: Arial, sans-serif;");
        console.log("}\n");
      }
      // Simple React component
      else if (taskLower.includes("react") && taskLower.includes("component")) {
        console.log("\nHere is a simple React component:\n");
        console.log("import React from 'react';");
        console.log("");
        console.log("const SimpleComponent = () => {");
        console.log("  return (");
        console.log("    <div>");
        console.log("      <h1>Hello from React!</h1>");
        console.log("      <p>This is a simple React component.</p>");
        console.log("    </div>");
        console.log("  );");
        console.log("  ");
        console.log("export default SimpleComponent;\n");
      }
      // Basic SQL query
      else if (
        taskLower.includes("sql") &&
        (taskLower.includes("select") || taskLower.includes("query"))
      ) {
        console.log("\nHere is a basic SQL SELECT query:\n");
        console.log("SELECT column1, column2, ...");
        console.log("FROM table_name");
        console.log("WHERE condition;");
        console.log("");
        console.log("Example:");
        console.log("SELECT first_name, last_name, email");
        console.log("FROM users");
        console.log("WHERE age > 18;\n");
      }
      // Node.js login backend (simplified)
      else if (
        taskLower.includes("nodejs") &&
        taskLower.includes("backend") &&
        taskLower.includes("login")
      ) {
        console.log(
          "\nGenerating a simple Node.js login backend structure...\n",
        );
        console.log(
          "// This is a simplified template. For full functionality, use the full version.\n",
        );
        console.log("const express = require('express');");
        console.log("const app = express();");
        console.log("app.use(express.json());");
        console.log("");
        console.log("app.post('/login', (req, res) => {");
        console.log("  const { username, password } = req.body;");
        console.log("  // TODO: Add authentication logic");
        console.log(
          "  res.json({ message: 'Login endpoint', user: username });",
        );
        console.log("});");
        console.log("");
        console.log("const PORT = process.env.PORT || 3000;");
        console.log(
          "app.listen(PORT, () => console.log(`Server running on port ${PORT}`));",
        );
      }
      // If none of the above, suggest using templates or full version
      else {
        console.log(
          "\n⚠️  This task is too complex for the lightweight version to generate files.",
        );
        console.log(
          "Please use the full version of coding-agent for complex tasks.\n",
        );
        console.log(
          "💡 Suggestion: Try breaking down your task into smaller, more specific requests.",
        );
        console.log("💡 Examples of supported tasks:");
        console.log('   - "create a hello world function"');
        console.log('   - "create a python function to calculate factorial"');
        console.log('   - "create a simple html page"');
        console.log('   - "create a basic css reset"');
        console.log('   - "create a simple react component"');
        console.log('   - "create a basic sql select query"');
        console.log('   - "create a nodejs backend for a login page"');
        console.log(
          '   - "create a nodejs backend for a login page please --output-dir ./my-project --force"',
        );
      }
    }
  });

program.parse();
