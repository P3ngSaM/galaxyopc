# Changelog

All notable changes to this open-source repository will be documented in this file.

## [0.2.1] - 2026-04-20

### Added

- Local startup wizard for non-technical users to configure models, channels, search and physical-space modules
- Official API Key and documentation links for built-in model providers
- Enterprise WeChat and DingTalk configuration panels for local edition service credentials
- Always-visible IoT platform entrance alongside city management

### Changed

- Expanded local settings navigation to include Feishu, Enterprise WeChat and DingTalk as collaboration channels
- Added more OpenAI-compatible model provider presets for local self-hosted configuration

## [0.2.0] - 2026-04-17

### Added

- Initial open-source release of `GalaxyOPC`
- Apache 2.0 license and notice files
- Public-facing GitHub `README.md`
- Deployment, configuration, architecture and quick-start docs
- Open-source roadmap for local desktop packaging, onboarding wizard and collaboration channels
- Local Edition product notes for Windows / macOS packaging and simplified configuration
- Minimal sample `research` JSON data for demo startup
- Clean repository layout for standalone publishing

### Changed

- Extracted `opc-server` into a dedicated standalone repository
- Updated `package.json` metadata for public GitHub distribution
- Kept PostgreSQL and SQLite dual-engine support

### Removed

- Private environment variables
- Local databases and WAL files
- Logs, certificates and local debug artifacts
- Upload materials and generated video outputs
- Internal business documents and original research datasets
- Build artifacts and runtime-only files
