@echo off
setlocal EnableDelayedExpansion
set DIRNAME=%~dp0
set APP_HOME=%DIRNAME%

if not "%JAVA_HOME%"=="" goto run
if exist "%DIRNAME%..\resources\jdk-21" (
  set "JAVA_HOME=%DIRNAME%..\resources\jdk-21"
  goto run
)

echo ERROR: JAVA_HOME not set and resources/jdk-21 not found.
exit /b 1

:run
set WRAPPER_JAR=%APP_HOME%gradle\wrapper\gradle-wrapper.jar
if not exist "%WRAPPER_JAR%" (
  echo ERROR: gradle-wrapper.jar not found.
  exit /b 1
)
if not "%JAVA_HOME%"=="" (
  set "GRADLE_OPTS=-Dorg.gradle.java.home=%JAVA_HOME%"
)
"%JAVA_HOME%\bin\java.exe" -Dorg.gradle.appname=gradlew -classpath "%WRAPPER_JAR%" org.gradle.wrapper.GradleWrapperMain %*
exit /b %ERRORLEVEL%
