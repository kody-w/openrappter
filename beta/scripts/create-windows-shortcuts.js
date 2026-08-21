if (WScript.Arguments.length < 2) {
  WScript.Echo("Expected Electron executable and beta app directory.");
  WScript.Quit(2);
}

var electron = WScript.Arguments.Item(0);
var appDirectory = WScript.Arguments.Item(1);
var shell = new ActiveXObject("WScript.Shell");
var fileSystem = new ActiveXObject("Scripting.FileSystemObject");
var name = "RAPP Brainstem Frontier.lnk";
var legacyName = "RAPP Brainstem Beta.lnk";

function createShortcut(folder) {
  var legacyPath = fileSystem.BuildPath(folder, legacyName);
  if (fileSystem.FileExists(legacyPath)) fileSystem.DeleteFile(legacyPath, true);
  var shortcut = shell.CreateShortcut(fileSystem.BuildPath(folder, name));
  shortcut.TargetPath = electron;
  shortcut.Arguments = '"' + appDirectory + '"';
  shortcut.WorkingDirectory = appDirectory;
  shortcut.IconLocation = electron + ",0";
  shortcut.Description = "Skill Recorder-style launcher for the shared RAPP Brainstem";
  shortcut.Save();
}

createShortcut(shell.SpecialFolders("Desktop"));
createShortcut(shell.SpecialFolders("Programs"));
