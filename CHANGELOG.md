## [1.9.24]
## Added
- Pascal string constants workaround

## [1.9.23] - 2025-06-13
## Added
- Support for new VSCode 1.101.0 and SSH node module crashes, disabled

## [1.9.22] - 2025-06-05
## Added
- Pascal uppercase for variable watches defaults to True (fixes some local variable issues)
- Signals are caught and displayed
- Unknown source code line on break is not displayed, instead the first working source code is used

## [1.9.21] - 2025-05-20
## Fixed
- <null> variable has no children count

## [1.9.20] - 2025-05-13
## Fixed
- Breakpoint issue (sometimes all breakpoints were removed)
- Centralized type handling for pascal

## [1.9.19] - 2025-04-28
## Fixed
- Nil instances display members no more

## [1.9.18] - 2025-04-22
## Fixed
- memory view fixed
- Ctrl+F (find dialog) vs shortcut conflict attempt

## [1.9.17] - 2025-04-15
## Added
- FPC exceptions catching
- Call stack #NaN fixed
- FPC exception name retrieved from $rdi and displayed as an error message
- FPC class members - function Getter vs Fvar member for hover watch support
## Fixed
- SIGINT select.c breakpoint not trigged on breakpoint toggle
- arrays: length +1

## [1.9.16] - 2025-04-09
## Added
- general arrays support
## Fixed
- string types used instead
- arrays length fixed

## [1.9.15] - 2025-04-8
## Added
- option activateTerminal
- option clearTerminal
- FPC arrays support
- FPC shortstring, ansistring handling, decoding and utf8 support

## [0.9.15] - 2023-05-30
## Fixed
- Resolve the issue of not being able to set breakpoints when using SSH for remote debugging in Linux.

## [0.9.14] - 2022-11-23
## Added
- Add language argument for launching c++, pascal program.

## [0.9.12] - 2022-11-21
## Added
- Open SSH shell as terminal for debug.
- Show progress when uploading file through ssh.
- Only modified files will be uploaded.

## [0.9.11] - 2022-10-25
## Added
- Use gdb through SSH

## [0.9.10] - 2022-10-17
## Fixed
- Breakpointer not inserted after attach

## [0.9.9] -  2022-10-11
### Fixed
 - repository url change to github
 - #2 command 'extension.pickNativeProcess' already exists

## [0.9.7] -  2022-10-09
### Added
- Support of display TString.Strings for Free pascal.
- Support set breakpoint at runing on windows
- Show thread id in call stack window
- Pick process for attach

### Fixed
- The utf8 string is displayed incorrectly.

## [0.9.6] -  2021-06-15
### Added
- Add `View Memory` Command. Will open memery data in `Microsoft Hex Editor` if it installed.
- Add `View Memory` menu in editor on debuging.

## [0.9.5] -  2021-06-13
### Fixed
- Parse failure on some data whith \.

## [0.9.4] -  2020-10-15
### Added
- Supports set variable value
- Use vscode terminal to show program's output on linux and macOS.
### Fixed
- Failure to set breakpoints during debugging multi-threaded programs on Linux

## [0.9.3] -  2020-10-14
### Added
- Highlighting when an exception is triggered
### Fixed
- Variable display is wrong after stackframe switched

## [0.9.2] -  2020-09-24
### Added
- add `programArgs` Set the inferior program arguments, to be used in the program run
- add `commandsBeforeExec` Commands run before execution.
## [0.9.1] -  2020-09-17
### Changed
-  Change keyword in `package.json`
## [0.9.0] - 2020/09/16
### Added
* Initial release


