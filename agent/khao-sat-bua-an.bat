@echo off
chcp 65001 >nul
title Khao sat bua an - Truong Ngoi Sao Hoang Mai
cd /d "%~dp0"

REM Gui email moi CBGV-NV lam khao sat chat luong suat an cua tuan.
REM Task Scheduler goi kem --quiet vao 15:00 thu 6 (lap moi 15 phut trong 1 gio),
REM 07:30 -> 12:30 hang ngay va luc khoi dong may (gui bu khi thu 6 gui loi):
REM cua so chay an nen khong ai doc duoc man hinh, vi vay ghi toan bo ket qua
REM vao khao-sat.log canh file nay, va khong dung lai cho bam phim.
REM Nhan --quiet bang chinh cmd, KHONG dung lenh find: may co cai Git for
REM Windows (kem cong cu Unix trong PATH) thi "find" la ban khac, khong bao
REM gio thay --quiet, task chay an se treo o lenh pause cuoi file.
set "QUIET="
for %%A in (%*) do if /i "%%~A"=="--quiet" set "QUIET=1"
if not defined QUIET goto chay_tay

REM Log qua 5 MB thi doi ten thanh khao-sat.old.log (giu mot ban cu).
if exist "%~dp0khao-sat.log" for %%F in ("%~dp0khao-sat.log") do if %%~zF GTR 5000000 move /y "%%~fF" "%~dp0khao-sat.old.log" >nul

>>"%~dp0khao-sat.log" echo.
>>"%~dp0khao-sat.log" echo ===== %date% %time% ===== tham so: %*
node survey-invite.mjs %* >>"%~dp0khao-sat.log" 2>&1
set "RC=%errorlevel%"
>>"%~dp0khao-sat.log" echo ===== ket thuc, ma thoat %RC% =====

REM Tra lai dung ma thoat cua node de Task Scheduler hien "Last Run Result":
REM 0 = on (hoac khong co gi phai lam), 1 = loi cau hinh / loi chung (chua
REM gui loi moi nao), 2 = co thu gui loi hoac khong ro da di chua (lan chay sau
REM gui not nguoi chac chan chua nhan), 3 = DA gui nhung khong ghi duoc trang
REM thai (lan chay sau tu ghi lai, khong gui trung).
exit /b %RC%

:chay_tay
node survey-invite.mjs %*
set "RC=%errorlevel%"

REM Chay tay (bam dup) thi dung lai de doc ket qua.
echo.
pause
exit /b %RC%
