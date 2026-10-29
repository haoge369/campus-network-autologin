' Silent launcher: wscript -> node campus_login.js, no cmd.exe in the chain.
' Used by the scheduled tasks (CampusLogin_AutoStartup / CampusLogin_Daily0610).
Option Explicit

Dim ws, fso, scriptDir, nodeExe, candidates, i

Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = scriptDir

nodeExe = ""
candidates = Array( _
    ws.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    ws.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    ws.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe") _
)

For i = 0 To UBound(candidates)
    If fso.FileExists(candidates(i)) Then
        nodeExe = candidates(i)
        Exit For
    End If
Next

If nodeExe = "" Then nodeExe = "node.exe"

' 0 = hidden window, False = do not wait (the task ends immediately)
' --auto: 计划任务模式——每次开机最多自动启用一次网卡，之后不再拉起用户手动禁用的网卡
' --quiet: 不往控制台输出（日志照常写入 campus_login.log）
ws.Run """" & nodeExe & """ """ & scriptDir & "\campus_login.js"" --auto --quiet", 0, False
