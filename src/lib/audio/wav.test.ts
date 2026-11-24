import { describe, expect, it } from "vitest";

import { ASR_SAMPLE_RATE, bytesToBase64, encodeWavPcm16, mixToMono } from "./wav";

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

describe("encodeWavPcm16", () => {
  it("写出合法的 44 字节头", () => {
    const samples = new Float32Array([0, 0.5, -0.5]);
    const wav = encodeWavPcm16(samples, ASR_SAMPLE_RATE);
    const view = new DataView(wav.buffer);

    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 12)).toBe("WAVE");
    expect(ascii(wav, 12, 16)).toBe("fmt ");
    expect(ascii(wav, 36, 40)).toBe("data");

    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(wav.byteLength).toBe(44 + samples.length * 2);
  });

  it("采样值 clamp 到 int16 范围", () => {
    const wav = encodeWavPcm16(new Float32Array([2, -2, 0]), ASR_SAMPLE_RATE);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(0);
  });
});

describe("mixToMono", () => {
  it("多声道取平均", () => {
    const fake = {
      numberOfChannels: 2,
      length: 3,
      getChannelData: (c: number) =>
        c === 0 ? new Float32Array([1, 0.5, -1]) : new Float32Array([-1, 0.5, 1]),
    } as unknown as AudioBuffer;

    expect(Array.from(mixToMono(fake))).toEqual([0, 0.5, 0]);
  });
});

describe("bytesToBase64", () => {
  it("编码字节数组", () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe("SGk=");
  });

  it("跨分块拼接正确", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 3);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;
    const b64 = bytesToBase64(bytes);
    const decoded = atob(b64);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(1);
    expect(decoded.charCodeAt(decoded.length - 1)).toBe(2);
  });
});
