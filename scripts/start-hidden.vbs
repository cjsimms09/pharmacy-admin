' Starts the launcher without a visible console window (used by "Install autostart.cmd").
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Environment("Process")("NO_BROWSER") = "1"
sh.Run "cmd /c node scripts\launch.mjs > data\launcher.log 2>&1", 0, False
