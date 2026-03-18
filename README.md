# Coding Agent

A lightweight, file-based coding CLI tool that can create, update, and manage file structures for common development tasks with minimal system overhead.

## 🚀 Features

- **Instant File Creation**: Generate actual file structures (not just terminal output)
- **File Updates with Diff**: See exactly what changes when updating existing files
- **Smart Skip Behavior**: Preserves existing files unless forced to overwrite
- **Ultra-Lightweight**: Minimal dependencies, fast startup, low memory usage
- **Template-Based Generation**: Boilerplate code for common tasks

## 🤖 Powered By

This tool is built using:

- **[opencode](https://opencode.ai/zen)** - The AI-powered coding assistant framework
- **[Claude Code](https://claude.ai/code)** - Anthropic's AI coding assistant
- **Ollama Models** - Local LLM models for private, offline AI capabilities

## 📦 Installation

```bash
# Clone or download this repository
git clone <repository-url>
cd coding-agent

# Install dependencies
npm install

# The tool is ready to use immediately
```

## 💡 Usage

### Run from Project Directory

```bash
# Create a Node.js login backend (files go to ./generated)
node bin/run.js run "create a nodejs backend for a login page please" --force

# Create a simple HTML page
node bin/run.js run "create a simple html page" --force

# Create a React component
node bin/run.js run "create a simple react component" --force
```

### Update Files (See Diff)

```bash
# Modify a file manually, then run again to see changes
node bin/run.js run "create a nodejs backend for a login page please" --force
```

### Simple Tasks (Text Output)

```bash
node bin/run.js run "create a hello world function"
node bin/run.js run "create a python function to calculate factorial"
```

### Run Anywhere with npx

Once the package is published (or after installing locally), you can use it from any folder without cloning:

```bash
# Using npx (no installation needed)
npx coding-agent run "create a nodejs backend for a login page please" --force

# Or install globally first
npm install -g .
coding-agent run "create a nodejs backend for a login page please" --force
```

## 📊 Performance

- **Startup Time**: ~38ms (help command)
- **Dependencies**: 12 packages
- **Memory Footprint**: <50 MB
- **Bundle Size**: ~59 MB node_modules

## 📁 Project Structure Created

When generating a Node.js login backend, you'll get:

```
your-project/
├── server.js              # Main Express server
├── package.json           # Dependencies & scripts
├── .env.example           # Environment template
├── .gitignore             # Git ignore rules
├── README.md              # Documentation
├── config/
│   └── database.js        # DB config (in-memory/MongoDB)
├── controllers/
│   └── authController.js  # Auth logic (register, login, protect)
└── routes/
    └── auth.js            # Auth routes with validation
```

## 🔑 Key Features

### File Operations

- **Create**: Generate new file structures instantly
- **Update**: Modify existing files with diff visualization
- **Skip**: Preserve existing files unless `--force` is used
- **Directory Management**: Automatically creates needed directories

### Supported Tasks (File Creation)

- Node.js login/backend with JWT auth
- Simple HTML pages
- CSS resets
- React components
- Python/JavaScript functions (factorial, hello world, etc.)
- Basic SQL queries
- And more...

### Simple Tasks (Text Output)

- Hello world functions (multiple languages)
- Factorial functions
- Basic code snippets
- Quick reference examples

## 🛠️ Customization

Edit `bin/run.js` to add more template-based responses for your common tasks.

## ⚙️ Configuration

The tool requires no API keys or external services to operate.

## 📄 Files in This Repository

- `package.json` - Project dependencies and scripts
- `bin/run.js` - Enhanced CLI with file creation/update capabilities
- `.gitignore` - Git ignore rules
- `.eslintrc.json` - ESLint configuration
- `CLAUDE.md` - Claude Code guidelines
- `ARCHITECTURE.md` - System architecture documentation

## 💻 Example Workflow

```bash
# 1. Create project structure
node bin/run.js run "create a nodejs backend for a login page please" --force

# 2. Navigate to project
cd ./generated

# 3. Install dependencies
npm install

# 4. Configure environment
cp .env.example .env
# Edit .env to set your JWT_SECRET

# 5. Start development server
npm run dev

# 6. Test the API
# Register: curl -X POST http://localhost:5000/api/auth/register -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"password123","name":"Test User"}'
# Login: curl -X POST http://localhost:5000/api/auth/login -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"password123"}'
```

## 🏁 Getting Started

```bash
# Install dependencies (once)
npm install

# Create your first project from anywhere
npx coding-agent run "create a nodejs backend for a login page please" --force

# You now have a complete file structure ready to run!
```

---

_Built with ❤️ for developers who want instant results without system overhead._
_Powered by opencode.ai/zen, claude.ai/code, and ollama models._
