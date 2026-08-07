@echo off
chcp 65001 >nul
title Dong bo cham an - Truong Ngoi Sao Hoang Mai
cd /d "%~dp0"

node sync-checkins.mjs %*

REM Chay tay (bam dup) thi dung lai de doc ket qua.
REM Task Scheduler goi kem tham so --quiet thi khong dung, de tu dong dong cua so.
echo %* | find "--quiet" >nul
if errorlevel 1 (
  echo.
  pause
)
