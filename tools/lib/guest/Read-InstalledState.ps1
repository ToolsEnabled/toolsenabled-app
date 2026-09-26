param([Parameter(Mandatory=$true)][ValidateSet('toolsenabled','scribe','web-editor','presentation-suite')][string]$Product)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Read-only native measurement. No registry write/create, ShellExecute,
# shortcut Resolve/Save, installer invocation, environment expansion or ACL edit.
$installedStateNative = @'
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using Microsoft.Win32.SafeHandles;

public static class InstalledStateNative {
  // The OS token selects the only readable profile. No path or environment
  // input can select another account's installation.
  static readonly string Dev = OwnerProfile();
  const string Uninstall = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
  const uint Read = 0x20019, OpenLink = 8, Reparse = 0x400;
  [DllImport("advapi32.dll")] static extern int RegOpenCurrentUser(uint access, out IntPtr result);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegOpenKeyEx(IntPtr parent, string name, uint options, uint access, out IntPtr result);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegQueryValueEx(IntPtr key, string name, IntPtr reserved, out uint type, byte[] data, ref uint bytes);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegEnumKeyEx(IntPtr key, uint index, StringBuilder name, ref uint length, IntPtr reserved, IntPtr className, IntPtr classLength, IntPtr time);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder directory, ref uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
  [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written; public uint volume, highSize, lowSize, links, highIndex, lowIndex; }

  static string OwnerProfile() {
    using(var owner=WindowsIdentity.GetCurrent()) {
      uint length=32768; var actual=new StringBuilder((int)length);
      if(!GetUserProfileDirectory(owner.Token,actual,ref length)) throw new Exception("cannot measure current OS account profile");
      string profile=actual.ToString();
      if(profile.Length<4 || profile[1]!=':' || profile[2]!='\\' ||
          !Path.GetFullPath(profile).Equals(profile,StringComparison.OrdinalIgnoreCase) ||
          profile.Substring(3).Split('\\').Any(p=>p.Length==0 || p=="." || p==".." || p.EndsWith(".") || p.EndsWith(" ") || p.IndexOfAny(new char[]{':','/','\0','*','?'})>=0))
        throw new Exception("current OS account profile is not an ordinary absolute path");
      return profile;
    }
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int maximum, IntPtr data, uint flags);
    void GetIDList(out IntPtr list); void SetIDList(IntPtr list);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int maximum); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int maximum); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int maximum);
  }
  public class Identity { public string product, displayName, installDir, registryKey, shortcut, runtime, shell, uninstaller; }
  public class Entry { public string key; public Dictionary<string,string> values = new Dictionary<string,string>(); public Dictionary<string,uint> valueTypes = new Dictionary<string,uint>(); }
  public class RegistryView { public string view; public bool rootPresent; public List<Entry> entries = new List<Entry>(); }
  public class Issue { public string location, code; public Issue(string location, string code) { this.location=location; this.code=code; } }
  public class FileRow { public string relativePath, sha256; public long bytes; }
  public class Shortcut { public string path, target, argumentsRaw, sha256; public long bytes; }
  public class Report {
    public string schema="toolsenabled.native-installed-state", product, profileRoot=Dev, accountSid, installDir, registryRoot=Uninstall;
    public int schemaVersion=1; public bool installRootPresent, complete; public long censusEntries;
    public Identity identity; public List<RegistryView> views=new List<RegistryView>(), viewsAfter=new List<RegistryView>(); public List<FileRow> files=new List<FileRow>();
    public List<Shortcut> shortcuts=new List<Shortcut>(); public List<Issue> unreadable=new List<Issue>(), reparsePoints=new List<Issue>();
  }
  static Identity Policy(string product) {
    string display, slug, key;
    switch(product) {
      case "toolsenabled": display="ToolsEnabled"; slug="toolsenabled"; key="21cb002d-a6ac-5e62-b88d-ba3c87d67396"; break;
      case "scribe": display="ToolsEnabled Scribe"; slug="scribe"; key=slug; break;
      case "web-editor": display="ToolsEnabled Web Studio"; slug="web-editor"; key=slug; break;
      case "presentation-suite": display="ToolsEnabled Presentation Editor"; slug="presentation-suite"; key=slug; break;
      default: throw new Exception("unknown fixed product");
    }
    bool app=product=="toolsenabled";
    return new Identity { product=product, displayName=display, installDir=Dev+@"\AppData\Local\Programs\"+slug, registryKey=Uninstall+@"\"+key,
      shortcut=Dev+@"\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\"+(app ? display+".lnk" : display+@"\"+display+".lnk"),
      runtime=app ? "ToolsEnabled.exe" : @"runtime\electron\electron.exe", shell=app ? @"resources\app.asar" : @"shell\main.js",
      uninstaller=app ? "Uninstall ToolsEnabled.exe" : "Uninstall.exe" };
  }
  static string Sha(Stream stream) { using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
  static void Error(Report report, string location, Exception error) {
    (error.Message=="reparse-point" ? report.reparsePoints : report.unreadable).Add(new Issue(location,error.Message));
  }
  // Every ancestor is opened without following its final reparse point and
  // held without delete sharing before the next component is opened. A path
  // cannot be replaced with a junction between the check and the file read.
  sealed class FileLease : IDisposable {
    public List<SafeFileHandle> handles=new List<SafeFileHandle>(); public SafeFileHandle file; public FileInfo info;
    public void Dispose() { for(int i=handles.Count-1;i>=0;i--) handles[i].Dispose(); }
  }
  static FileLease OpenPlain(string name, bool directory, bool content) {
    if(!name.StartsWith(Dev+@"\",StringComparison.OrdinalIgnoreCase) && !name.Equals(Dev,StringComparison.OrdinalIgnoreCase)) throw new Exception("outside-profile-fence");
    string suffix=name.Substring(Dev.Length).TrimStart('\\');
    string[] parts=suffix.Length==0 ? new string[0] : suffix.Split('\\');
    if(parts.Any(p=>p.Length==0 || p=="." || p==".." || p.EndsWith(".") || p.EndsWith(" ") || p.IndexOfAny(new char[]{':','/','\0','*','?'})>=0)) throw new Exception("ambiguous-file-path");
    var lease=new FileLease();
    string root=Path.GetPathRoot(Dev), ownerSuffix=Dev.Substring(root.Length);
    string[] ownerParts=ownerSuffix.Split('\\');
    string[] locations=new[]{root}.Concat(ownerParts.Select((part,index)=>root+String.Join(@"\",ownerParts.Take(index+1))))
      .Concat(parts.Select((part,index)=>Dev+@"\"+String.Join(@"\",parts.Take(index+1)))).ToArray();
    try {
      for(int index=0;index<locations.Length;index++) {
        string current=locations[index]; bool last=index==locations.Length-1;
        uint access=last && content ? 0x80000000u : 0x80u;
        // The data file denies writes too, and stays locked through COM Load.
        var handle=CreateFile(current,access,last && content ? 1u : 3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
        if(handle.IsInvalid) { int code=Marshal.GetLastWin32Error(); handle.Dispose(); if(code==2 || code==3) throw new FileNotFoundException(); throw new Exception("file-open-error-"+code); }
        lease.handles.Add(handle); FileInfo info;
        if(!GetFileInformationByHandle(handle,out info)) throw new Exception("file-information-error-"+Marshal.GetLastWin32Error());
        if((info.attributes&Reparse)!=0) throw new Exception("reparse-point");
        if((!last || directory) != ((info.attributes&0x10)!=0)) throw new Exception("unexpected-file-type");
        if(last) { lease.file=handle; lease.info=info; }
      }
      return lease;
    } catch { lease.Dispose(); throw; }
  }
  static FileRow FileBytes(string file, string relative) {
    using(var lease=OpenPlain(file,false,true)) {
      long size=((long)lease.info.highSize<<32)+lease.info.lowSize;
      if(size>8L*1024*1024*1024) throw new Exception("file-byte-budget-exceeded");
      using(var stream=new FileStream(lease.file,FileAccess.Read)) { string digest=Sha(stream); if(stream.Position!=size) throw new Exception("file-size-changed"); return new FileRow { relativePath=relative,bytes=size,sha256=digest }; }
    }
  }
  static void Census(string directory, string relative, Report report) {
    using(var lease=OpenPlain(directory,true,false)) {
      string[] before=Directory.GetFileSystemEntries(directory).OrderBy(n=>n,StringComparer.Ordinal).ToArray();
      foreach(string child in before) {
        if(++report.censusEntries>100000) throw new Exception("installed-entry-budget-exceeded");
        string rel=relative.Length==0 ? Path.GetFileName(child) : relative+@"\"+Path.GetFileName(child);
        try {
          // Parent directory lease remains held. Attribute inspection does not
          // traverse the final child when it is a junction/symbolic link.
          FileAttributes attributes=File.GetAttributes(child);
          if((attributes&FileAttributes.ReparsePoint)!=0) { report.reparsePoints.Add(new Issue(rel,"reparse-point")); continue; }
          if((attributes&FileAttributes.Directory)!=0) Census(child,rel,report);
        } catch(Exception error) { Error(report,rel,error); }
      }
      string[] after=Directory.GetFileSystemEntries(directory).OrderBy(n=>n,StringComparer.Ordinal).ToArray();
      if(!before.SequenceEqual(after,StringComparer.Ordinal)) throw new Exception("installed-directory-changed");
    }
  }
  static Shortcut ReadShortcut(string file) {
    using(var lease=OpenPlain(file,false,true)) {
      long size=((long)lease.info.highSize<<32)+lease.info.lowSize;
      if(size==0 || size>1024*1024) throw new Exception("shortcut-byte-budget");
      string digest; using(var stream=new FileStream(lease.file,FileAccess.Read)) {
        digest=Sha(stream);
        object link=new ShellLink();
        try {
          ((IPersistFile)link).Load(file,0x20); // STGM_READ | STGM_SHARE_DENY_WRITE; never Save/Resolve.
          var target=new StringBuilder(32768); var arguments=new StringBuilder(32768);
          ((IShellLinkW)link).GetPath(target,target.Capacity,IntPtr.Zero,4); // SLGP_RAWPATH: no expansion or target lookup.
          ((IShellLinkW)link).GetArguments(arguments,arguments.Capacity);
          if(target.Length==0 || target.Length>=target.Capacity-1 || arguments.Length>=arguments.Capacity-1) throw new Exception("shortcut-target-or-arguments-unmeasured");
          return new Shortcut { path=file,target=target.ToString(),argumentsRaw=arguments.ToString(),bytes=size,sha256=digest };
        } finally { Marshal.FinalReleaseComObject(link); }
      }
    }
  }
  static IntPtr RegistryChild(IntPtr parent, string name, uint view) {
    IntPtr key; int result=RegOpenKeyEx(parent,name,OpenLink,Read|view,out key);
    if(result==2) return IntPtr.Zero; if(result!=0) throw new Exception("registry-open-error-"+result);
    uint type, bytes=0; result=RegQueryValueEx(key,"SymbolicLinkValue",IntPtr.Zero,out type,null,ref bytes);
    if((result==0 || result==234) && type==6) { RegCloseKey(key); throw new Exception("reparse-point"); }
    if(result!=0 && result!=2 && result!=234) { RegCloseKey(key); throw new Exception("registry-link-check-error-"+result); }
    return key;
  }
  static string RegistryValue(IntPtr key,string name,out uint type) {
    uint length=0; int result=RegQueryValueEx(key,name,IntPtr.Zero,out type,null,ref length);
    if(result==2) { type=0; return null; }
    if(result!=0 || length>65536) throw new Exception("registry-value-type-or-size-"+result);
    // Unrelated programs may use non-string metadata. Preserve its type without
    // interpreting or requiring their private implementation to use our schema.
    if(type!=1 && type!=2) return null;
    if((length&1)!=0) throw new Exception("odd-registry-string-size");
    byte[] data=new byte[length]; result=RegQueryValueEx(key,name,IntPtr.Zero,out type,data,ref length);
    if(result!=0) throw new Exception("registry-value-read-error-"+result);
    string text=Encoding.Unicode.GetString(data,0,(int)length).TrimEnd('\0');
    if(text.IndexOf('\0')>=0) throw new Exception("embedded-registry-null"); return text;
  }
  static RegistryView ReadRegistry(uint flag, Report report) {
    var view=new RegistryView { view=flag==0x100 ? "64" : "32" }; var handles=new List<IntPtr>();
    try {
      IntPtr key; int result=RegOpenCurrentUser(Read,out key); if(result!=0) throw new Exception("current-user-registry-error-"+result); handles.Add(key);
      foreach(string part in Uninstall.Split('\\')) { key=RegistryChild(key,part,flag); if(key==IntPtr.Zero) return view; handles.Add(key); }
      view.rootPresent=true;
      for(uint index=0;index<4096;index++) {
        var name=new StringBuilder(512); uint length=(uint)name.Capacity;
        result=RegEnumKeyEx(key,index,name,ref length,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
        if(result==259) return view; if(result!=0) throw new Exception("registry-enumeration-error-"+result);
        string full=Uninstall+@"\"+name; IntPtr child=IntPtr.Zero;
        try {
          child=RegistryChild(key,name.ToString(),flag); if(child==IntPtr.Zero) throw new Exception("registry-entry-disappeared");
          var entry=new Entry { key=full };
          foreach(string value in new[]{"DisplayName","Publisher","UninstallString","QuietUninstallString","InstallLocation","DisplayVersion"}) {
            uint type; string text=RegistryValue(child,value,out type); if(type!=0) { entry.values[value]=text; entry.valueTypes[value]=type; }
          }
          view.entries.Add(entry);
        } catch(Exception error) { Error(report,"HKCU["+view.view+"]\\"+full,error); }
        finally { if(child!=IntPtr.Zero) RegCloseKey(child); }
      }
      throw new Exception("registry-entry-budget-exceeded");
    } catch(Exception error) { Error(report,"HKCU["+view.view+"]\\"+Uninstall,error); return view; }
    finally { for(int i=handles.Count-1;i>=0;i--) RegCloseKey(handles[i]); }
  }
  public static Report Measure(string product) {
    Identity identity=Policy(product);
    using(var user=WindowsIdentity.GetCurrent()) {
      if(!OwnerProfile().Equals(Dev,StringComparison.OrdinalIgnoreCase)) throw new Exception("current OS account profile changed before native measurement");
      var report=new Report { product=product,identity=identity,installDir=identity.installDir,accountSid=user.User.Value };
      report.views.Add(ReadRegistry(0x100,report)); report.views.Add(ReadRegistry(0x200,report));
      try { using(var root=OpenPlain(identity.installDir,true,false)) { report.installRootPresent=true; Census(identity.installDir,"",report); } }
      catch(FileNotFoundException) { } catch(Exception error) { Error(report,"install-root",error); }
      foreach(string relative in new[]{identity.runtime,identity.shell,identity.uninstaller}) {
        try { report.files.Add(FileBytes(Path.Combine(identity.installDir,relative),relative)); }
        catch(FileNotFoundException) { } catch(Exception error) { Error(report,relative,error); }
      }
      try { report.shortcuts.Add(ReadShortcut(identity.shortcut)); }
      catch(FileNotFoundException) { } catch(Exception error) { Error(report,"start-menu-shortcut",error); }
      report.viewsAfter.Add(ReadRegistry(0x100,report)); report.viewsAfter.Add(ReadRegistry(0x200,report));
      report.complete=report.unreadable.Count==0 && report.reparsePoints.Count==0; return report;
    }
  }
}
'@
Add-Type -TypeDefinition $installedStateNative
[InstalledStateNative]::Measure($Product) | ConvertTo-Json -Depth 12 -Compress
