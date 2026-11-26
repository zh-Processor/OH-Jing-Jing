using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class WindowsTranscriptionWorker
{
    private const int AudioLimit = 4 * 1024 * 1024;
    private const int ModelRate = 16000;
    private const ulong MiB = 1024 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, Load;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual,
            AvailableVirtual, AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void vosk_set_log_level(int level);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr vosk_model_new(byte[] path);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void vosk_model_free(IntPtr model);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr vosk_recognizer_new(IntPtr model, float rate);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int vosk_recognizer_accept_waveform_s(IntPtr decoder, short[] samples, int size);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr vosk_recognizer_result(IntPtr decoder);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr vosk_recognizer_final_result(IntPtr decoder);
    [DllImport("libvosk.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void vosk_recognizer_free(IntPtr decoder);

    private static MemoryStatus ReadMemory()
    {
        var status = new MemoryStatus { Length = (uint)Marshal.SizeOf(typeof(MemoryStatus)) };
        if (!GlobalMemoryStatusEx(ref status)) throw new InvalidOperationException("Could not check available memory.");
        return status;
    }

    private static bool HasRoom(MemoryStatus status)
    {
        return status.AvailablePhysical >= 256 * MiB && status.AvailablePageFile >= 768 * MiB;
    }

    private static byte[] ReadAudio(Stream stream)
    {
        using (var result = new MemoryStream())
        {
            var chunk = new byte[16384];
            int read;
            while ((read = stream.Read(chunk, 0, chunk.Length)) != 0)
            {
                if (result.Length + read > AudioLimit) throw new InvalidDataException("Audio exceeds the byte limit.");
                result.Write(chunk, 0, read);
            }
            return result.ToArray();
        }
    }

    private static short[] NormalizeWave(byte[] bytes)
    {
        if (bytes.Length < 44 || !Tag(bytes, 0, "RIFF") || !Tag(bytes, 8, "WAVE") ||
            BitConverter.ToUInt32(bytes, 4) != bytes.Length - 8)
            throw new InvalidDataException("Expected a PCM WAV file.");
        int rate = 0, channels = 0, width = 0, data = -1, length = 0, offset = 12;
        while (offset + 8 <= bytes.Length)
        {
            int start = offset + 8;
            uint size = BitConverter.ToUInt32(bytes, offset + 4);
            long padded = (long)size + (size & 1);
            if (padded > bytes.Length - start) throw new InvalidDataException("Invalid WAV chunk.");
            if (Tag(bytes, offset, "fmt "))
            {
                if (rate != 0 || size < 16 || BitConverter.ToUInt16(bytes, start) != 1)
                    throw new InvalidDataException("Expected one PCM format declaration.");
                channels = BitConverter.ToUInt16(bytes, start + 2);
                rate = BitConverter.ToInt32(bytes, start + 4);
                int bits = BitConverter.ToUInt16(bytes, start + 14);
                width = bits / 8;
                if (channels < 1 || channels > 2 || rate < 8000 || rate > 48000 ||
                    width < 1 || width > 4 || bits != width * 8 ||
                    BitConverter.ToUInt16(bytes, start + 12) != channels * width ||
                    BitConverter.ToUInt32(bytes, start + 8) != rate * channels * width)
                    throw new InvalidDataException("Unsupported PCM format.");
            }
            else if (Tag(bytes, offset, "data"))
            {
                if (data >= 0) throw new InvalidDataException("Expected one WAV data chunk.");
                data = start;
                length = (int)size;
            }
            offset = start + (int)padded;
        }
        int stride = channels * width;
        if (offset != bytes.Length || rate == 0 || data < 0 || length == 0 || length % stride != 0)
            throw new InvalidDataException("Missing PCM samples.");
        int frames = length / stride;
        if (frames > 60L * rate) throw new InvalidDataException("Audio exceeds the duration limit.");
        var result = new short[(int)((long)frames * ModelRate / rate)];
        for (int i = 0; i < result.Length; i++)
        {
            long position = (long)i * rate;
            int left = (int)(position / ModelRate);
            int a = Frame(bytes, data + left * stride, channels, width);
            int b = Frame(bytes, data + Math.Min(left + 1, frames - 1) * stride, channels, width);
            result[i] = (short)(a + (b - a) * (position % ModelRate) / ModelRate);
        }
        return result;
    }

    private static bool Tag(byte[] bytes, int offset, string tag)
    {
        return bytes[offset] == tag[0] && bytes[offset + 1] == tag[1] && bytes[offset + 2] == tag[2] && bytes[offset + 3] == tag[3];
    }

    private static int Frame(byte[] bytes, int offset, int channels, int width)
    {
        int first = Sample(bytes, offset, width);
        return channels == 1 ? first : (first + Sample(bytes, offset + width, width)) / 2;
    }

    private static int Sample(byte[] bytes, int offset, int width)
    {
        if (width == 1) return (bytes[offset] - 128) << 8;
        return BitConverter.ToInt16(bytes, offset + width - 2);
    }

    private static void AppendResult(List<string> parts, IntPtr result)
    {
        if (result == IntPtr.Zero) return;
        int length = 0;
        while (length < 16384 && Marshal.ReadByte(result, length) != 0) length++;
        if (length == 16384) throw new InvalidDataException("Recognition result exceeds the output limit.");
        var json = new byte[length];
        Marshal.Copy(result, json, 0, length);
        var response = Json.Deserialize<Dictionary<string, string>>(Encoding.UTF8.GetString(json));
        string text;
        if (response.TryGetValue("text", out text) && !String.IsNullOrWhiteSpace(text)) parts.Add(text.Trim());
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            var memory = ReadMemory();
            if (args.Length == 1 && args[0] == "--check")
            {
                Console.WriteLine(Json.Serialize(new { ready = HasRoom(memory), freePhysicalMiB = memory.AvailablePhysical / MiB,
                    spareCommitMiB = memory.AvailablePageFile / MiB }));
                return 0;
            }
            if (args.Length != 0) return 2;
            if (!HasRoom(memory)) return Busy();
            using (var lease = new Mutex(false, @"Global\OHJingJing.WindowsAsr"))
            {
                bool held;
                try { held = lease.WaitOne(0); }
                catch (AbandonedMutexException) { held = true; }
                if (!held) return Busy();
                try
                {
                    var samples = NormalizeWave(ReadAudio(Console.OpenStandardInput()));
                    if (!HasRoom(ReadMemory())) return Busy();
                    var text = Recognize(samples);
                    using (var process = Process.GetCurrentProcess())
                        Console.WriteLine(Json.Serialize(new { state = "ready", text,
                            peakWorkingMiB = Math.Ceiling(process.PeakWorkingSet64 / (double)MiB),
                            peakCommitMiB = Math.Ceiling(process.PeakPagedMemorySize64 / (double)MiB) }));
                }
                finally { lease.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception)
        {
            Console.Error.WriteLine("Windows speech recognition did not complete.");
            return 1;
        }
    }

    private static int Busy()
    {
        Console.WriteLine("{\"state\":\"busy\"}");
        return 0;
    }

    private static string Recognize(short[] samples)
    {
        var modelBytes = Encoding.UTF8.GetBytes(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "model") + "\0");
        vosk_set_log_level(-1);
        IntPtr model = vosk_model_new(modelBytes);
        if (model == IntPtr.Zero) throw new InvalidOperationException("Could not start the speech model.");
        var parts = new List<string>();
        try
        {
            IntPtr decoder = vosk_recognizer_new(model, ModelRate);
            if (decoder == IntPtr.Zero) throw new InvalidOperationException("Could not start speech recognition.");
            try
            {
                var chunk = new short[4000];
                for (int offset = 0; offset < samples.Length; offset += chunk.Length)
                {
                    int length = Math.Min(chunk.Length, samples.Length - offset);
                    Array.Copy(samples, offset, chunk, 0, length);
                    int result = vosk_recognizer_accept_waveform_s(decoder, chunk, length);
                    if (result < 0) throw new InvalidOperationException("Speech decoding failed.");
                    if (result == 1) AppendResult(parts, vosk_recognizer_result(decoder));
                }
                AppendResult(parts, vosk_recognizer_final_result(decoder));
            }
            finally { vosk_recognizer_free(decoder); }
        }
        finally { vosk_model_free(model); }
        return String.Join(" ", parts);
    }
}
