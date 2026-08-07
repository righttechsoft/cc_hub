@echo off
rem Alias: `resume` == `cc-attach --resume` (resume the previous claude session under the wrapper).
rem Named `resume` rather than `continue` because `continue` is a reserved keyword in both
rem PowerShell and bash, so it can never be invoked as an external command there.
"%~dp0cc-attach.cmd" --resume %*
