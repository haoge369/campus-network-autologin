Dim ws, fso, scriptDir
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = scriptDir
ws.Run """C:\Program Files\nodejs\node.exe"" """ & scriptDir & "\campus_login.js""", 0, False
