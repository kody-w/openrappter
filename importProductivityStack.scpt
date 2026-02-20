-- AppleScript: importProductivityStack.scpt
set theNoteTitle to "Productivity Stack Plan"
set theNoteBody to (do shell script "cat /Users/kodyw/Library/CloudStorage/OneDrive-Microsoft/Projects/rappter/openrappter-obsidian/Productivity_Stack_Plan.md")
tell application "Notes"
    set theFolder to first folder whose name is "Notes" -- Change if needed
    make new note at theFolder with properties {name:theNoteTitle, body:theNoteBody}
end tell
