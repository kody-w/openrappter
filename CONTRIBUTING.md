# Contributing to openRAPPter

Thank you for your interest in contributing to openRAPPter! 🦖

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/openrappter.git
   cd openrappter
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

### Running Locally

```bash
# Development mode with hot reload
npm run dev

# Build
npm run build

# Run tests
npm test
```

### Project Structure

```
openrappter/
├── bin/              # CLI entry point
├── src/              # TypeScript source
│   ├── commands/     # CLI commands
│   ├── agents/       # Agent logic
│   ├── memory/       # Memory system
│   ├── skills/       # Skills system
│   └── tui/          # Terminal UI
├── docs/             # Documentation (GitHub Pages)
├── tests/            # Test files
├── RAPPagent.py      # Python standalone version
└── package.json
```

### Code Style

- Use TypeScript with strict mode
- Follow existing patterns
- Keep functions small and focused
- Add JSDoc comments for public APIs

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

## Pull Request Process

1. Update documentation if needed
2. Add tests for new features
3. Ensure all tests pass
4. Update CHANGELOG.md
5. Submit PR with clear description

## Reporting Issues

- Check existing issues first
- Include reproduction steps
- Provide system information (OS, Node version, etc.)

## Code of Conduct

- Be respectful and inclusive
- Focus on the code, not the person
- Help others learn

## Questions?

Open an issue or discussion on GitHub!
