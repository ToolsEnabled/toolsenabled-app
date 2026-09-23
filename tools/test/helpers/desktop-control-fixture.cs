using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public static class ControlFixture {
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  [STAThread] public static void Main(string[] options) {
    Application.EnableVisualStyles();
    var form = new Form { Text = "Mechanical control test", Width = 760, Height = 780 };
    form.Resize += (s, e) => { Console.WriteLine("window:" + form.WindowState); Console.Out.Flush(); };
    form.FormClosed += (s, e) => { Console.WriteLine("closed"); Console.Out.Flush(); };
    if (Array.IndexOf(options, "--cancel-close") >= 0) {
      form.FormClosing += (s, e) => { e.Cancel = true; Console.WriteLine("close-refused"); Console.Out.Flush(); };
    }
    var label = new Label { Text = "Notes", Top = 12, Left = 12, Width = 160 };
    var text = new TextBox { AccessibleName = "Notes", Top = 38, Left = 12, Width = 400, Text = "original fixture text" };
    var button = new Button { Text = "Test press", Top = 80, Left = 12, Width = 140 };
    var documentLabel = new Label { Text = "Document", Top = 125, Left = 12 };
    var document = new RichTextBox { Top = 155, Left = 12, Width = 400, Height = 80 };
    var hidden = new TextBox { Top = 260, Left = 12, UseSystemPasswordChar = true, Text = "fixture-secret" };
    var toggle = new CheckBox { Text = "Test toggle", Top = 300, Left = 12, Width = 180 };
    toggle.CheckedChanged += (s, e) => { Console.WriteLine("toggle:" + toggle.Checked); Console.Out.Flush(); };
    var list = new ListBox { AccessibleName = "Test choices", Top = 340, Left = 12, Width = 180, Height = 75 };
    list.Items.AddRange(new object[] {"Choice alpha", "Choice beta"});
    list.SelectedIndexChanged += (s, e) => { Console.WriteLine("selected:" + list.SelectedItem); Console.Out.Flush(); };
    // A legacy UIA provider can update native selection without the managed
    // event. Observe the actual field independently instead of requiring that event.
    var lastSelection = -1;
    var observer = new Timer { Interval = 50 };
    observer.Tick += (s, e) => {
      if (lastSelection != list.SelectedIndex) {
        lastSelection = list.SelectedIndex;
        Console.WriteLine("observed-selection:" + list.SelectedItem); Console.Out.Flush();
      }
    };
    observer.Start();
    var tree = new TreeView { AccessibleName = "Test tree", Top = 430, Left = 12, Width = 220, Height = 100 };
    tree.Nodes.Add(new TreeNode("Test branch", new TreeNode[] { new TreeNode("Test leaf") }));
    tree.AfterExpand += (s, e) => { Console.WriteLine("expanded"); Console.Out.Flush(); };
    tree.AfterCollapse += (s, e) => { Console.WriteLine("collapsed"); Console.Out.Flush(); };
    var scroll = new ListBox { AccessibleName = "Test scrolling", Top = 545, Left = 12, Width = 220, Height = 100 };
    for (int i=0;i<60;i++) scroll.Items.Add("Scroll row " + i);
    button.Click += (sender, args) => { button.Text = "Pressed once"; Console.WriteLine("clicked"); Console.Out.Flush(); };
    text.TextChanged += (sender, args) => { Console.WriteLine("text:" + text.Text); Console.Out.Flush(); };
    form.Shown += (sender, args) => {
      // Shown is a managed lifecycle event, not native visibility. A quiet
      // parent can leave this disposable test form hidden. Show only our own
      // form, without activation, and refuse readiness if Windows kept it hidden.
      bool wasVisible = IsWindowVisible(form.Handle);
      Console.WriteLine("shown-native-visible:" + wasVisible);
      if (!wasVisible) ShowWindow(form.Handle, 4); // SW_SHOWNOACTIVATE
      if (!IsWindowVisible(form.Handle)) {
        Console.Error.WriteLine("Fixture native visibility was not established.");
        Console.Error.Flush(); Environment.Exit(1); return;
      }
      Console.WriteLine("ready"); Console.Out.Flush();
    };
    document.TextChanged += (sender, args) => { Console.WriteLine("document:" + document.Text); Console.Out.Flush(); };
    form.Controls.AddRange(new Control[] {label, text, button, documentLabel, document, hidden, toggle, list, tree, scroll});
    for (int i = 0; i < 7; i++) {
      form.Controls.Add(new TextBox { AccessibleName = "Read-only context " + i, ReadOnly = true,
        Text = new string((char)('a' + i), 3000), Left = 450, Top = 12 + i * 36, Width = 260 });
    }
    form.Controls.Add(new RichTextBox { ReadOnly = true, Text = "Read-only document fixture",
      Left = 450, Top = 290, Width = 260, Height = 70 });
    Application.Run(form);
    observer.Dispose();
  }
}
