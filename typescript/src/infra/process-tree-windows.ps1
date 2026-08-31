$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace OpenRappter {
  public static class ManagedProcessTreeHelper {
    private const int ConfigMaxBytes = 1048576;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public UInt64 ReadOperationCount;
      public UInt64 WriteOperationCount;
      public UInt64 OtherOperationCount;
      public UInt64 ReadTransferCount;
      public UInt64 WriteTransferCount;
      public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public Int64 PerProcessUserTimeLimit;
      public Int64 PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
      IntPtr job,
      int informationClass,
      ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
      uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    private sealed class Config {
      public int version { get; set; }
      public string command { get; set; }
      public string[] args { get; set; }
      public string cwd { get; set; }
      public Dictionary<string, string> env { get; set; }
      public string control_pipe { get; set; }
    }

    private static void Win32(bool succeeded, string operation) {
      if (!succeeded) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Windows process-tree containment failed during " + operation + "."
        );
      }
    }

    private static byte[] ReadBoundedConfig(Stream input) {
      using (var buffer = new MemoryStream()) {
        while (buffer.Length <= ConfigMaxBytes) {
          int value = input.ReadByte();
          if (value < 0) throw new InvalidDataException("Missing helper configuration.");
          if (value == 10) return buffer.ToArray();
          buffer.WriteByte((byte)value);
        }
      }
      throw new InvalidDataException("Helper configuration exceeds its bound.");
    }

    private static void ValidateText(string value, string name, bool allowEmpty) {
      if (
        value == null ||
        (!allowEmpty && value.Length == 0) ||
        value.IndexOf('\0') >= 0 ||
        Encoding.UTF8.GetByteCount(value) > 32767
      ) {
        throw new InvalidDataException(name + " is invalid.");
      }
    }

    private static Config ReadConfig(Stream input) {
      var utf8 = new UTF8Encoding(false, true);
      var json = utf8.GetString(ReadBoundedConfig(input));
      var config = new JavaScriptSerializer {
        MaxJsonLength = ConfigMaxBytes,
        RecursionLimit = 16
      }.Deserialize<Config>(json);
      if (config == null || config.version != 1) {
        throw new InvalidDataException("Unsupported helper protocol.");
      }
      ValidateText(config.command, "command", false);
      if (config.args == null || config.args.Length > 256) {
        throw new InvalidDataException("args is invalid.");
      }
      for (int index = 0; index < config.args.Length; index++) {
        ValidateText(config.args[index], "argument", true);
      }
      if (config.cwd != null) ValidateText(config.cwd, "cwd", false);
      if (config.env == null || config.env.Count > 256) {
        throw new InvalidDataException("env is invalid.");
      }
      foreach (var entry in config.env) {
        ValidateText(entry.Key, "environment key", false);
        ValidateText(entry.Value, "environment value", true);
        if (entry.Key.IndexOf('=') >= 0) {
          throw new InvalidDataException("environment key is invalid.");
        }
      }
      ValidateText(config.control_pipe, "control pipe", false);
      if (
        config.control_pipe.Length > 128 ||
        !System.Text.RegularExpressions.Regex.IsMatch(
          config.control_pipe,
          "^[A-Za-z0-9-]+$"
        )
      ) {
        throw new InvalidDataException("control pipe is invalid.");
      }
      return config;
    }

    // Implements the CommandLineToArgvW inverse used by the Windows C runtime.
    // Metacharacters remain ordinary argv bytes because no shell is involved.
    private static string QuoteWindowsArgument(string argument) {
      if (argument.Length == 0) return "\"\"";
      if (argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;

      var result = new StringBuilder("\"");
      int backslashes = 0;
      foreach (char character in argument) {
        if (character == '\\') {
          backslashes++;
          continue;
        }
        if (character == '"') {
          result.Append('\\', backslashes * 2 + 1);
          result.Append('"');
          backslashes = 0;
          continue;
        }
        result.Append('\\', backslashes);
        backslashes = 0;
        result.Append(character);
      }
      result.Append('\\', backslashes * 2);
      result.Append('"');
      return result.ToString();
    }

    private static string Incarnation(Process process) {
      return "win:" + process.StartTime.ToUniversalTime().ToFileTimeUtc();
    }

    private static void WriteReady(Stream output, Process target) {
      var helper = Process.GetCurrentProcess();
      var ready = new Dictionary<string, object> {
        { "protocol", 1 },
        { "helper_pid", helper.Id },
        { "helper_incarnation", Incarnation(helper) },
        { "target_pid", target.Id },
        { "target_incarnation", Incarnation(target) }
      };
      var json = new JavaScriptSerializer().Serialize(ready) + "\n";
      var bytes = new UTF8Encoding(false).GetBytes(json);
      output.Write(bytes, 0, bytes.Length);
      output.Flush();
    }

    private static void ControlLoop(
      NamedPipeServerStream control,
      Process target,
      IntPtr job
    ) {
      try {
        control.WaitForConnection();
        using (var reader = new StreamReader(
          control,
          new UTF8Encoding(false, true),
          false,
          256,
          true
        )) {
          while (true) {
            string command = reader.ReadLine();
            if (command == null) return;
            if (command == "terminate") {
              try { target.StandardInput.Close(); } catch { }
              try { target.CloseMainWindow(); } catch { }
            } else if (command == "kill") {
              // The helper is in this Job Object. Terminating the job kills the
              // helper and every target descendant as one kernel operation.
              Win32(TerminateJobObject(job, 137), "TerminateJobObject");
              return;
            } else {
              return;
            }
          }
        }
      } catch {
        // Control failure cannot weaken containment. If the Node supervisor
        // closes this helper, KILL_ON_JOB_CLOSE still kills the entire job.
      }
    }

    public static int Run() {
      Stream input = Console.OpenStandardInput();
      Stream output = Console.OpenStandardOutput();
      Stream error = Console.OpenStandardError();
      Config config = ReadConfig(input);

      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) {
        throw new Win32Exception(
          Marshal.GetLastWin32Error(),
          "Windows process-tree containment could not create a Job Object."
        );
      }

      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Win32(
        SetInformationJobObject(
          job,
          JobObjectExtendedLimitInformation,
          ref limits,
          (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))
        ),
        "SetInformationJobObject"
      );

      // Join containment before target creation. Breakaway flags are
      // deliberately absent, so the child and every descendant inherit the job.
      Win32(
        AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle),
        "AssignProcessToJobObject"
      );

      using (var control = new NamedPipeServerStream(
        config.control_pipe,
        PipeDirection.In,
        1,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous
      ))
      using (var target = new Process()) {
        var start = new ProcessStartInfo {
          FileName = config.command,
          Arguments = String.Join(
            " ",
            Array.ConvertAll<string, string>(
              config.args,
              QuoteWindowsArgument
            )
          ),
          UseShellExecute = false,
          RedirectStandardInput = true,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
          CreateNoWindow = true
        };
        if (config.cwd != null) start.WorkingDirectory = config.cwd;
        start.EnvironmentVariables.Clear();
        foreach (var entry in config.env) {
          start.EnvironmentVariables[entry.Key] = entry.Value;
        }
        target.StartInfo = start;
        if (!target.Start()) throw new InvalidOperationException("Target did not start.");

        WriteReady(output, target);

        Task.Run(() => ControlLoop(control, target, job));
        Task.Run(async () => {
          try {
            await input.CopyToAsync(target.StandardInput.BaseStream);
            target.StandardInput.Close();
          } catch { }
        });
        Task stdout = target.StandardOutput.BaseStream.CopyToAsync(output);
        Task stderr = target.StandardError.BaseStream.CopyToAsync(error);

        target.WaitForExit();
        int exitCode = target.ExitCode;
        try { Task.WaitAll(new[] { stdout, stderr }, 250); } catch { }

        // Returning preserves the target exit status. Process exit then closes
        // the helper's only Job handle; KILL_ON_JOB_CLOSE atomically removes any
        // descendant that outlived the target.
        return exitCode;
      }
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.Web.Extensions
  $exitCode = [OpenRappter.ManagedProcessTreeHelper]::Run()
  exit $exitCode
} catch {
  # Fixed text only: target argv/environment may contain credentials and must
  # never be echoed by helper diagnostics.
  [Console]::Error.WriteLine('process-tree-helper: startup failed')
  exit 125
}
