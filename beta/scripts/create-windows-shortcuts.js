if (WScript.Arguments.length < 3) {
  WScript.Echo("Expected OpenRappter launcher, beta app directory, and Electron icon.");
  WScript.Quit(2);
}

var launcher = WScript.Arguments.Item(0);
var appDirectory = WScript.Arguments.Item(1);
var electron = WScript.Arguments.Item(2);
var shell = new ActiveXObject("WScript.Shell");
var fileSystem = new ActiveXObject("Scripting.FileSystemObject");
var name = "OpenRappter.lnk";
var legacyNames = [
  "RAPP Brainstem Frontier.lnk",
  "RAPP Brainstem Beta.lnk",
];

function createShortcut(folder) {
  for (var i = 0; i < legacyNames.length; i += 1) {
    var legacyPath = fileSystem.BuildPath(folder, legacyNames[i]);
    if (fileSystem.FileExists(legacyPath)) fileSystem.DeleteFile(legacyPath, true);
  }
  var shortcut = shell.CreateShortcut(fileSystem.BuildPath(folder, name));
  shortcut.TargetPath = launcher;
  shortcut.Arguments = "";
  shortcut.WorkingDirectory = appDirectory;
  shortcut.IconLocation = electron + ",0";
  shortcut.Description = "Local-first OpenRappter AI agent application";
  shortcut.Save();
}

createShortcut(shell.SpecialFolders("Desktop"));
createShortcut(shell.SpecialFolders("Programs"));
