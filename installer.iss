; osu!helper — Inno Setup installer script
; Requires: Inno Setup 6 (https://jrsoftware.org/isinfo.php)
; Run after PyInstaller has built dist\osuhelper\

[Setup]
AppName=osu!helper
AppVersion=1.0
AppPublisher=bunglest
AppPublisherURL=https://osuhelper.com
AppSupportURL=https://osuhelper.com
DefaultDirName={autopf}\osu!helper
DefaultGroupName=osu!helper
AllowNoIcons=yes
OutputDir=output
OutputBaseFilename=osuhelper_setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=osu!helper
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: checked

[Files]
Source: "dist\osuhelper\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\osu!helper";                      Filename: "{app}\osuhelper.exe"
Name: "{group}\Uninstall osu!helper";            Filename: "{uninstallexe}"
Name: "{autodesktop}\osu!helper";                Filename: "{app}\osuhelper.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\osuhelper.exe"; Description: "Launch osu!helper"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Clean up AppData settings on uninstall (optional — comment out to keep user data)
; Type: filesandordirs; Name: "{userappdata}\osuhelper"
