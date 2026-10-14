// STRATUM VST2 host: loads a .vst bundle through the interface in vst2abi.h. Called from vst3host.mm, which gives both
// plugin formats the same C interface.
#include "vst2host.h"
#include "vst2abi.h"
#import <Cocoa/Cocoa.h>
#include <map>
#include <mutex>
#include <string>
#include <vector>

struct V2
{
	CFBundleRef bundle = nullptr;
	V2Effect *fx = nullptr;
	NSView *host = nil;
	NSTimer *idle = nil;
	double sr = 44100;
	int block = 1024;
	bool active = false;
	V2Time time {};
	std::vector<V2MidiEvent> queue;
	V2Events events {};
	std::vector<std::vector<float>> inData, outData;
	std::vector<float *> inPtrs, outPtrs;
};

namespace {
std::mutex &tableLock () { static std::mutex m; return m; }
std::map<V2Effect *, V2 *> &table () { static std::map<V2Effect *, V2 *> t; return t; }
V2 *ownerOf (V2Effect *fx) { std::lock_guard<std::mutex> g (tableLock ()); auto it = table ().find (fx); return it == table ().end () ? nullptr : it->second; }

intptr_t hostCallback (V2Effect *fx, int32_t op, int32_t index, intptr_t value, void *ptr, float opt)
{
	V2 *p = fx ? ownerOf (fx) : nullptr;
	switch (op)
	{
		case V2H_VERSION: return 2400;
		case V2H_TIME: return p ? (intptr_t)&p->time : 0;
		case V2H_RATE: return p ? (intptr_t)p->sr : 44100;
		case V2H_BLOCK: return p ? p->block : 1024;
		case V2H_LEVEL: return 0;
		case V2H_VENDOR: if (ptr) strcpy ((char *)ptr, "STRATUM"); return 1;
		case V2H_PRODUCT: if (ptr) strcpy ((char *)ptr, "STRATUM"); return 1;
		case V2H_VENDOR_VERSION: return 1000;
		case V2H_CAN_DO:
		{
			const char *s = (const char *)ptr;
			return s && (!strcmp (s, "sendVstEvents") || !strcmp (s, "sendVstMidiEvent") || !strcmp (s, "sendVstTimeInfo") || !strcmp (s, "sizeWindow")) ? 1 : 0;
		}
		case V2H_RESIZE:
			if (p && p->host)
			{
				NSSize size = NSMakeSize (index, value);
				dispatch_async (dispatch_get_main_queue (), ^{ if (p->host) { [p->host setFrameSize:size]; if (p->host.window) [p->host.window setContentSize:size]; } });
				return 1;
			}
			return 0;
		default: return 0;
	}
}

typedef V2Effect *(*EntryPoint) (V2HostCallback);

V2Effect *instantiate (const char *path, CFBundleRef *bundleOut, std::string &err)
{
	CFURLRef url = CFURLCreateFromFileSystemRepresentation (nullptr, (const UInt8 *)path, (CFIndex)strlen (path), true);
	CFBundleRef bundle = url ? CFBundleCreate (nullptr, url) : nullptr;
	if (url) CFRelease (url);
	if (!bundle || !CFBundleLoadExecutable (bundle)) { if (bundle) CFRelease (bundle); err = "The plugin could not be loaded (it may be built for a different processor)"; return nullptr; }
	auto entry = (EntryPoint)CFBundleGetFunctionPointerForName (bundle, CFSTR ("VSTPluginMain"));
	if (!entry) entry = (EntryPoint)CFBundleGetFunctionPointerForName (bundle, CFSTR ("main_macho"));
	V2Effect *fx = entry ? entry (hostCallback) : nullptr;
	if (!fx || fx->magic != V2_MAGIC) { err = "This file is not a VST2 plugin"; CFRelease (bundle); return nullptr; }
	*bundleOut = bundle;
	return fx;
}

std::string escape (const char *s)
{
	std::string o;
	for (; *s; s++) { unsigned char c = (unsigned char)*s; if (c == '"' || c == '\\') { o += '\\'; o += (char)c; } else if (c >= 32) o += (char)c; }
	return o;
}
}

int v2_scan (const char *path, char *json, int cap)
{
	@autoreleasepool {
		std::string err;
		CFBundleRef bundle = nullptr;
		V2Effect *fx = instantiate (path, &bundle, err);
		if (!fx) return -1;
		char name[256] = {0}, vendor[256] = {0};
		fx->dispatch (fx, V2_OPEN, 0, 0, nullptr, 0);
		fx->dispatch (fx, V2_NAME, 0, 0, name, 0);
		if (!name[0]) fx->dispatch (fx, V2_PRODUCT, 0, 0, name, 0);
		fx->dispatch (fx, V2_VENDOR, 0, 0, vendor, 0);
		bool synth = fx->flags & V2_FLAG_SYNTH;
		fx->dispatch (fx, V2_CLOSE, 0, 0, nullptr, 0);
		std::string out = std::string ("[{\"cid\":\"VST2\",\"name\":\"") + escape (name) + "\",\"vendor\":\"" + escape (vendor) + "\",\"sub\":\"" + (synth ? "Instrument" : "Fx") + "\"}]";
		if ((int)out.size () + 1 > cap) return -1;
		memcpy (json, out.c_str (), out.size () + 1);
		return 1;
	}
}

V2 *v2_load (const char *path, char *err, int err_len)
{
	@autoreleasepool {
		std::string e;
		auto p = new V2 ();
		p->fx = instantiate (path, &p->bundle, e);
		if (!p->fx) { if (err && err_len > 0) snprintf (err, err_len, "%s", e.c_str ()); delete p; return nullptr; }
		{ std::lock_guard<std::mutex> g (tableLock ()); table ()[p->fx] = p; }
		p->queue.reserve (256);
		p->fx->dispatch (p->fx, V2_OPEN, 0, 0, nullptr, 0);
		return p;
	}
}

static void stop (V2 *p)
{
	if (!p->active) return;
	p->fx->dispatch (p->fx, V2_STOP, 0, 0, nullptr, 0);
	p->fx->dispatch (p->fx, V2_RESUME, 0, 0, nullptr, 0);
	p->active = false;
}

void v2_destroy (V2 *p)
{
	if (!p) return;
	@autoreleasepool {
		v2_close_view (p);
		stop (p);
		p->fx->dispatch (p->fx, V2_CLOSE, 0, 0, nullptr, 0);
		{ std::lock_guard<std::mutex> g (tableLock ()); table ().erase (p->fx); }
		delete p;   // the bundle stays loaded: unloading plugin code that may still have timers or threads is not safe
	}
}

int v2_is_instrument (V2 *p) { return p && (p->fx->flags & V2_FLAG_SYNTH) ? 1 : 0; }

int v2_setup (V2 *p, double sample_rate, int max_frames)
{
	if (!p || !p->fx->process) return 0;
	stop (p);
	p->sr = sample_rate; p->block = max_frames > 0 ? max_frames : 1024;
	p->time = V2Time {};
	p->time.sampleRate = sample_rate; p->time.tempo = 120; p->time.sigNum = 4; p->time.sigDen = 4;
	p->time.flags = V2T_PLAYING | V2T_TEMPO | V2T_SIG | V2T_PPQ;
	int nIn = std::max (0, (int)p->fx->numInputs), nOut = std::max (0, (int)p->fx->numOutputs);
	p->inData.assign (nIn, std::vector<float> (p->block, 0.f)); p->outData.assign (nOut, std::vector<float> (p->block, 0.f));
	p->inPtrs.resize (nIn); p->outPtrs.resize (nOut);
	for (int i = 0; i < nIn; i++) p->inPtrs[i] = p->inData[i].data ();
	for (int i = 0; i < nOut; i++) p->outPtrs[i] = p->outData[i].data ();
	p->fx->dispatch (p->fx, V2_SET_RATE, 0, 0, nullptr, (float)sample_rate);
	p->fx->dispatch (p->fx, V2_SET_BLOCK, 0, p->block, nullptr, 0);
	p->fx->dispatch (p->fx, V2_RESUME, 0, 1, nullptr, 0);
	p->fx->dispatch (p->fx, V2_START, 0, 0, nullptr, 0);
	p->active = true;
	return 1;
}

void v2_note (V2 *p, int on, int pitch, float velocity, int sample_offset)
{
	if (!p || p->queue.size () >= 256) return;
	V2MidiEvent e {};
	e.type = 1; e.size = (int32_t)sizeof (V2MidiEvent); e.offset = sample_offset < 0 ? 0 : sample_offset;
	e.midi[0] = (char)(on ? 0x90 : 0x80); e.midi[1] = (char)(pitch & 127); e.midi[2] = (char)(on ? std::max (1, std::min (127, (int)(velocity * 127))) : 0);
	p->queue.push_back (e);
}

void v2_process (V2 *p, const float *const *in, float *const *out, int frames)
{
	if (!p || !p->active) { for (int c = 0; c < 2; c++) memset (out[c], 0, sizeof (float) * frames); return; }
	for (int done = 0; done < frames;)
	{
		int n = std::min (frames - done, p->block);
		if (done == 0 && !p->queue.empty ())
		{
			p->events.count = (int32_t)p->queue.size (); p->events.reserved = 0;
			for (size_t i = 0; i < p->queue.size (); i++) { p->queue[i].offset = std::min (p->queue[i].offset, n - 1); p->events.events[i] = &p->queue[i]; }
			p->fx->dispatch (p->fx, V2_EVENTS, 0, 0, &p->events, 0);
		}
		for (auto &ch : p->inData) std::fill (ch.begin (), ch.begin () + n, 0.f);
		if (in) for (size_t c = 0; c < p->inData.size () && c < 2; c++) memcpy (p->inData[c].data (), in[c] + done, sizeof (float) * n);
		for (auto &ch : p->outData) std::fill (ch.begin (), ch.begin () + n, 0.f);
		p->fx->process (p->fx, p->inPtrs.data (), p->outPtrs.data (), n);
		p->queue.clear ();
		p->time.samplePos += n; p->time.ppqPos = p->time.samplePos / p->sr * p->time.tempo / 60.0;
		for (int c = 0; c < 2; c++)
		{
			if (p->outData.empty ()) memset (out[c] + done, 0, sizeof (float) * n);
			else memcpy (out[c] + done, p->outData[std::min ((size_t)c, p->outData.size () - 1)].data (), sizeof (float) * n);
		}
		done += n;
	}
}

int v2_open_view (V2 *p, void *nsview, int *width, int *height)
{
	if (!p || !(p->fx->flags & V2_FLAG_EDITOR)) return 0;
	@autoreleasepool {
		v2_close_view (p);
		p->host = (__bridge NSView *)nsview;
		V2Rect *r = nullptr;
		p->fx->dispatch (p->fx, V2_EDIT_RECT, 0, 0, &r, 0);
		p->fx->dispatch (p->fx, V2_EDIT_OPEN, 0, 0, nsview, 0);
		p->fx->dispatch (p->fx, V2_EDIT_RECT, 0, 0, &r, 0);
		int w = r ? r->right - r->left : 480, h = r ? r->bottom - r->top : 320;
		if (width) *width = w;
		if (height) *height = h;
		[p->host setFrameSize:NSMakeSize (w, h)];
		V2Effect *fx = p->fx;
		p->idle = [NSTimer scheduledTimerWithTimeInterval:0.03 repeats:YES block:^(NSTimer *) { fx->dispatch (fx, V2_EDIT_IDLE, 0, 0, nullptr, 0); }];
		return 1;
	}
}

void v2_close_view (V2 *p)
{
	if (!p || !p->host) return;
	[p->idle invalidate]; p->idle = nil;
	p->fx->dispatch (p->fx, V2_EDIT_CLOSE, 0, 0, nullptr, 0);
	p->host = nil;
}

// Saved settings: one byte saying which form follows, then either the plugin's own chunk or its parameter values.
int v2_get_state (V2 *p, unsigned char **data, int *len)
{
	if (!p) return 0;
	if (p->fx->flags & V2_FLAG_CHUNKS)
	{
		void *chunk = nullptr;
		intptr_t n = p->fx->dispatch (p->fx, V2_GET_CHUNK, 0, 0, &chunk, 0);
		if (n > 0 && chunk)
		{
			auto buf = (unsigned char *)malloc ((size_t)n + 1);
			buf[0] = 'C'; memcpy (buf + 1, chunk, (size_t)n);
			*data = buf; *len = (int)n + 1;
			return 1;
		}
	}
	int n = std::max (0, (int)p->fx->numParams);
	auto buf = (unsigned char *)malloc (1 + sizeof (float) * (size_t)n);
	buf[0] = 'P';
	for (int i = 0; i < n; i++) { float v = p->fx->getParam ? p->fx->getParam (p->fx, i) : 0; memcpy (buf + 1 + sizeof (float) * (size_t)i, &v, sizeof (float)); }
	*data = buf; *len = 1 + (int)sizeof (float) * n;
	return 1;
}

int v2_set_state (V2 *p, const unsigned char *data, int len)
{
	if (!p || len < 1) return 0;
	if (data[0] == 'C') { p->fx->dispatch (p->fx, V2_SET_CHUNK, 0, len - 1, (void *)(data + 1), 0); return 1; }
	if (data[0] != 'P' || !p->fx->setParam) return 0;
	int n = std::min ((int)p->fx->numParams, (len - 1) / (int)sizeof (float));
	for (int i = 0; i < n; i++) { float v; memcpy (&v, data + 1 + sizeof (float) * (size_t)i, sizeof (float)); p->fx->setParam (p->fx, i, v); }
	return 1;
}
