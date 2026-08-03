@echo off
if not "%ROOT_BATCH%"/ == ""/ goto mkenv
if "%ROOT_BATCH%"/ == ""/ for %%a in (.. ..\.. ..\..\.. ..\..\..\.. ..\..\..\..\.. ..\..\..\..\..\.. ..\..\..\..\..\..\.. ..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\..\..) do if exist %%a\bin\_start.bat %%a\bin\_start go %0

:mkenv
for %%a in (.. ..\.. ..\..\.. ..\..\..\.. ..\..\..\..\.. ..\..\..\..\..\.. ..\..\..\..\..\..\.. ..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\.. ..\..\..\..\..\..\..\..\..\..) do if exist %%a\bin\_mkenv.bat call %%a\bin\_mkenv go %%a

:start
echo.
echo BUILD PROJECT ... DEMO/UDP_SRV/JAVA
echo --------------------------------------------------
 
for %%a in (*.class) do attrib -R %%a
for %%a in (*.class) do del %%a

javac udpcl.java

:end
echo --------------------------------------------------
echo FINISHED
