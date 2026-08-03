@echo off
if not "%ROOT_BATCH%"/ == ""/ goto mkenv
if "%ROOT_BATCH%"/ == ""/ for %%a in (.. ..\.. ..\..\.. ..\..\..\.. ..\..\..\..\.. ..\..\..\..\..\.. ..\..\..\..\..\..\.. ..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\..\..) do if exist %%a\bin\_start.bat %%a\bin\_start go %0

:mkenv
for %%a in (.. ..\.. ..\..\.. ..\..\..\.. ..\..\..\..\.. ..\..\..\..\..\.. ..\..\..\..\..\..\.. ..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\..\..) do if exist %%a\bin\_mkenv.bat call %%a\bin\_mkenv go %%a

:start
call sys_par

call setRoute %IP_TARGET%
if errorlevel 1 goto end

java udpcl %IP_TARGET% 5000

:end
