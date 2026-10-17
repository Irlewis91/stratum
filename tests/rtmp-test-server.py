# A minimal RTMP ingest for self-checks: handshake, answer connect / createStream / publish, record the media to an FLV
# file, and print what arrived as JSON. Usage: rtmp-test-server.py <port> <out.flv> <seconds>
import socket, struct, sys, json, time
port, out, secs = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(('127.0.0.1', port)); srv.listen(1)
srv.settimeout(60)
c, _ = srv.accept(); c.settimeout(10)
def rd(n):
    b = b''
    while len(b) < n:
        x = c.recv(n - len(b))
        if not x: raise EOFError
        b += x
    return b
c0c1 = rd(1537); c.sendall(b'\x03' + bytes(1536) + c0c1[1:]); rd(1536)
def amf_str(s): b = s.encode(); return b'\x02' + struct.pack('>H', len(b)) + b
def amf_num(v): return b'\x00' + struct.pack('>d', v)
def send(t, csid, msid, payload):
    h = bytes([csid]) + b'\0\0\0' + struct.pack('>I', len(payload))[1:] + bytes([t]) + struct.pack('<I', msid)
    # server uses 128-byte chunks
    out_ = h + payload[:128]; i = 128
    while i < len(payload): out_ += bytes([0xC0 | csid]) + payload[i:i+128]; i += 128
    c.sendall(out_)
def parse_amf(d):
    vals, o = [], 0
    while o < len(d):
        t = d[o]; o += 1
        if t == 0: vals.append(struct.unpack('>d', d[o:o+8])[0]); o += 8
        elif t == 2: n = struct.unpack('>H', d[o:o+2])[0]; vals.append(d[o+2:o+2+n].decode()); o += 2 + n
        elif t == 5: vals.append(None)
        elif t in (3, 8):
            if t == 8: o += 4
            obj = {}
            while True:
                n = struct.unpack('>H', d[o:o+2])[0]; o += 2
                if n == 0 and d[o] == 9: o += 1; break
                k = d[o:o+n].decode(); o += n
                sub = parse_amf_one(d, o); obj[k] = sub[0]; o = sub[1]
            vals.append(obj)
        elif t == 1: vals.append(bool(d[o])); o += 1
        else: break
    return vals
def parse_amf_one(d, o):
    t = d[o]; o += 1
    if t == 0: return struct.unpack('>d', d[o:o+8])[0], o + 8
    if t == 2: n = struct.unpack('>H', d[o:o+2])[0]; return d[o+2:o+2+n].decode(), o + 2 + n
    if t == 1: return bool(d[o]), o + 1
    if t == 5: return None, o
    raise ValueError(t)
chunk = 128; hdr = {}; part = {}; stats = {'commands': [], 'video': 0, 'audio': 0, 'keyframes': 0, 'vts': [], 'ats': [], 'avcc': None, 'aac': None, 'meta': None}
flv = open(out, 'wb'); flv.write(b'FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00')
end = time.time() + secs
try:
    while time.time() < end:
        b0 = rd(1)[0]; fmt = b0 >> 6; csid = b0 & 0x3F
        if csid == 0: csid = rd(1)[0] + 64
        elif csid == 1: x = rd(2); csid = x[0] + 64 + x[1] * 256
        h = hdr.get(csid, {'ts': 0, 'len': 0, 'type': 0, 'sid': 0})
        if fmt <= 2:
            ts = int.from_bytes(rd(3), 'big')
            if fmt <= 1: h['len'] = int.from_bytes(rd(3), 'big'); h['type'] = rd(1)[0]
            if fmt == 0: h['sid'] = struct.unpack('<I', rd(4))[0]
            if ts == 0xFFFFFF: ts = struct.unpack('>I', rd(4))[0]
            h['ts'] = ts if fmt == 0 else h['ts'] + ts
        hdr[csid] = h
        buf = part.get(csid, b'')
        buf += rd(min(chunk, h['len'] - len(buf)))
        if len(buf) < h['len']: part[csid] = buf; continue
        part[csid] = b''
        t, p, ts = h['type'], buf, h['ts']
        if t == 1: chunk = struct.unpack('>I', p)[0]
        elif t == 20:
            v = parse_amf(p); name, tx = v[0], v[1]; stats['commands'].append(name)
            if name == 'connect':
                send(20, 3, 0, amf_str('_result') + amf_num(tx) + b'\x05' + b'\x03' + struct.pack('>H', 4) + b'code' + amf_str('NetConnection.Connect.Success') + b'\0\0\x09')
            elif name == 'createStream': send(20, 3, 0, amf_str('_result') + amf_num(tx) + b'\x05' + amf_num(1))
            elif name == 'publish':
                stats['key'] = v[3]; stats['app_publish'] = True
                send(20, 5, 1, amf_str('onStatus') + amf_num(0) + b'\x05' + b'\x03' + struct.pack('>H', 4) + b'code' + amf_str('NetStream.Publish.Start') + b'\0\0\x09')
        elif t == 18: stats['meta'] = str(parse_amf(p)[:2])
        elif t in (8, 9):
            flv.write(bytes([t]) + len(p).to_bytes(3, 'big') + (ts & 0xFFFFFF).to_bytes(3, 'big') + bytes([ts >> 24 & 255]) + b'\0\0\0' + p + struct.pack('>I', len(p) + 11))
            if t == 9:
                if p[1] == 0: stats['avcc'] = p[5:9].hex() + ' sps/pps ok' if p[5] == 1 else 'bad'
                else: stats['video'] += 1; stats['keyframes'] += p[0] == 0x17; stats['vts'].append(ts)
            else:
                if p[1] == 0: stats['aac'] = p[2:4].hex()
                else: stats['audio'] += 1; stats['ats'].append(ts)
except (EOFError, socket.timeout) as e: stats['ended'] = repr(e)
flv.close()
mono = lambda xs: all(b >= a for a, b in zip(xs, xs[1:]))
stats['video_monotonic'] = mono(stats['vts']); stats['audio_monotonic'] = mono(stats['ats'])
stats['video_span'] = (stats['vts'][0], stats['vts'][-1]) if stats['vts'] else None
stats['audio_span'] = (stats['ats'][0], stats['ats'][-1]) if stats['ats'] else None
del stats['vts'], stats['ats']
print(json.dumps(stats, indent=1))
