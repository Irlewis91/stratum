// STRATUM VST3 host: loads a VST3 plugin with Steinberg's hosting classes and exposes it through the C calls in vst3host.h.
#include "vst3host.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/gui/iplugview.h"
#import <Cocoa/Cocoa.h>
#include <map>
#include <mutex>
#include <string>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {
std::map<std::string, VST3::Hosting::Module::Ptr> &modules () { static std::map<std::string, VST3::Hosting::Module::Ptr> m; return m; }

VST3::Hosting::Module::Ptr moduleFor (const std::string &path, std::string &err)
{
	auto &m = modules ();
	auto it = m.find (path);
	if (it != m.end ()) return it->second;
	static HostApplication *host = nullptr;
	if (!host) { host = new HostApplication (); PluginContextFactory::instance ().setPluginContext (host); }
	auto mod = VST3::Hosting::Module::create (path, err);
	if (mod) m[path] = mod;
	return mod;
}

std::string jsonEscape (const std::string &s)
{
	std::string o;
	for (unsigned char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (c < 32) o += ' '; else o += c; }
	return o;
}
}

// Receives knob movements from the plugin's editor and resize requests from its view.
struct V3;
struct Handler : IComponentHandler, IPlugFrame
{
	V3 *owner = nullptr;
	tresult PLUGIN_API beginEdit (ParamID) override { return kResultOk; }
	tresult PLUGIN_API performEdit (ParamID id, ParamValue v) override;
	tresult PLUGIN_API endEdit (ParamID) override { return kResultOk; }
	tresult PLUGIN_API restartComponent (int32) override { return kResultOk; }
	tresult PLUGIN_API resizeView (IPlugView *view, ViewRect *r) override;
	tresult PLUGIN_API queryInterface (const TUID iid, void **obj) override
	{
		if (FUnknownPrivate::iidEqual (iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual (iid, FUnknown::iid)) { *obj = static_cast<IComponentHandler *> (this); return kResultOk; }
		if (FUnknownPrivate::iidEqual (iid, IPlugFrame::iid)) { *obj = static_cast<IPlugFrame *> (this); return kResultOk; }
		*obj = nullptr; return kNoInterface;
	}
	uint32 PLUGIN_API addRef () override { return 1; }
	uint32 PLUGIN_API release () override { return 1; }
};

struct Bus { int channels = 0; std::vector<std::vector<float>> data; std::vector<float *> ptrs; };

struct V3
{
	VST3::Hosting::Module::Ptr module;
	IPtr<PlugProvider> provider;
	IPtr<IComponent> comp;
	IPtr<IEditController> ctrl;
	FUnknownPtr<IAudioProcessor> proc {nullptr};
	IPtr<IPlugView> view;
	NSView *host = nil;
	Handler handler;
	EventList events {512};
	EventList outEvents {64};
	ParameterChanges inParams {64};
	ParameterChanges outParams {64};
	std::mutex lock;
	std::vector<std::pair<ParamID, ParamValue>> pending;
	std::vector<Bus> ins, outs;
	std::vector<AudioBusBuffers> inBufs, outBufs;
	bool instrument = false, active = false;
	double sr = 44100;
	int block = 0;
	int64 pos = 0;
};

tresult PLUGIN_API Handler::performEdit (ParamID id, ParamValue v)
{
	std::lock_guard<std::mutex> g (owner->lock);
	owner->pending.emplace_back (id, v);
	return kResultOk;
}

tresult PLUGIN_API Handler::resizeView (IPlugView *view, ViewRect *r)
{
	if (!view || !r || !owner->host) return kInvalidArgument;
	NSSize size = NSMakeSize (r->getWidth (), r->getHeight ());
	[owner->host setFrameSize:size];
	if (owner->host.window) [owner->host.window setContentSize:size];
	view->onSize (r);
	return kResultOk;
}

extern "C" {

int v3_scan (const char *path, char *json, int cap)
{
	@autoreleasepool {
		std::string err;
		auto mod = moduleFor (path, err);
		if (!mod) return -1;
		std::string out = "[";
		int n = 0;
		for (auto &ci : mod->getFactory ().classInfos ())
		{
			if (ci.category () != kVstAudioEffectClass) continue;
			out += std::string (n++ ? "," : "") + "{\"cid\":\"" + ci.ID ().toString () + "\",\"name\":\"" + jsonEscape (ci.name ()) + "\",\"vendor\":\"" + jsonEscape (ci.vendor ()) + "\",\"sub\":\"" + jsonEscape (ci.subCategoriesString ()) + "\"}";
		}
		out += "]";
		if ((int)out.size () + 1 > cap) return -1;
		memcpy (json, out.c_str (), out.size () + 1);
		return n;
	}
}

V3 *v3_load (const char *path, const char *cid, char *err, int err_len)
{
	@autoreleasepool {
		auto fail = [&] (const std::string &m) -> V3 * { if (err && err_len > 0) snprintf (err, err_len, "%s", m.c_str ()); return nullptr; };
		std::string e;
		auto mod = moduleFor (path, e);
		if (!mod) return fail ("Could not load the plugin: " + e);
		auto &factory = mod->getFactory ();
		for (auto &ci : factory.classInfos ())
		{
			if (ci.category () != kVstAudioEffectClass || ci.ID ().toString () != cid) continue;
			auto p = new V3 ();
			p->module = mod;
			p->handler.owner = p;
			p->provider = owned (new PlugProvider (factory, ci, true));
			if (!p->provider->initialize ()) { p->provider = nullptr; delete p; return fail ("The plugin failed to start"); }
			p->comp = p->provider->getComponentPtr ();
			p->ctrl = p->provider->getControllerPtr ();
			p->proc = FUnknownPtr<IAudioProcessor> (p->comp);
			if (!p->comp || !p->proc) { delete p; return fail ("The plugin has no audio processor"); }
			if (p->ctrl) p->ctrl->setComponentHandler (&p->handler);
			p->instrument = ci.subCategoriesString ().find ("Instrument") != std::string::npos;
			return p;
		}
		return fail ("That plugin was not found in the file");
	}
}

static void stop (V3 *p)
{
	if (!p->active) return;
	p->proc->setProcessing (false);
	p->comp->setActive (false);
	p->active = false;
}

void v3_destroy (V3 *p)
{
	if (!p) return;
	@autoreleasepool {
		v3_close_view (p);
		stop (p);
		if (p->ctrl) p->ctrl->setComponentHandler (nullptr);
		p->proc = FUnknownPtr<IAudioProcessor> (nullptr);
		p->comp = nullptr; p->ctrl = nullptr; p->provider = nullptr;
		delete p;
	}
}

int v3_is_instrument (V3 *p) { return p && p->instrument; }

static void layout (V3 *p, BusDirection dir, std::vector<Bus> &buses, std::vector<AudioBusBuffers> &bufs)
{
	int n = p->comp->getBusCount (kAudio, dir);
	buses.assign (n, Bus ()); bufs.assign (n, AudioBusBuffers ());
	for (int i = 0; i < n; i++)
	{
		SpeakerArrangement arr = 0;
		p->proc->getBusArrangement (dir, i, arr);
		Bus &b = buses[i];
		b.channels = SpeakerArr::getChannelCount (arr);
		b.data.assign (b.channels, std::vector<float> (p->block, 0.f));
		b.ptrs.resize (b.channels);
		for (int c = 0; c < b.channels; c++) b.ptrs[c] = b.data[c].data ();
		bufs[i].numChannels = b.channels; bufs[i].silenceFlags = 0; bufs[i].channelBuffers32 = b.ptrs.data ();
		p->comp->activateBus (kAudio, dir, i, i == 0);
	}
}

int v3_setup (V3 *p, double sample_rate, int max_frames)
{
	if (!p) return 0;
	stop (p);
	p->sr = sample_rate; p->block = max_frames > 0 ? max_frames : 1024;
	ProcessSetup setup {kRealtime, kSample32, p->block, sample_rate};
	if (p->proc->setupProcessing (setup) != kResultOk) return 0;
	int nIn = p->comp->getBusCount (kAudio, kInput), nOut = p->comp->getBusCount (kAudio, kOutput);
	std::vector<SpeakerArrangement> inArr (nIn), outArr (nOut);
	for (int i = 0; i < nIn; i++) { p->proc->getBusArrangement (kInput, i, inArr[i]); if (i == 0) inArr[i] = SpeakerArr::kStereo; }
	for (int i = 0; i < nOut; i++) { p->proc->getBusArrangement (kOutput, i, outArr[i]); if (i == 0) outArr[i] = SpeakerArr::kStereo; }
	p->proc->setBusArrangements (nIn ? inArr.data () : nullptr, nIn, nOut ? outArr.data () : nullptr, nOut);
	layout (p, kInput, p->ins, p->inBufs);
	layout (p, kOutput, p->outs, p->outBufs);
	if (p->comp->getBusCount (kEvent, kInput) > 0) p->comp->activateBus (kEvent, kInput, 0, true);
	if (p->comp->setActive (true) != kResultOk) return 0;
	p->proc->setProcessing (true);
	p->active = true;
	return 1;
}

void v3_note (V3 *p, int on, int pitch, float velocity, int sample_offset)
{
	if (!p) return;
	Event e {};
	e.busIndex = 0; e.sampleOffset = sample_offset < 0 ? 0 : sample_offset; e.flags = Event::kIsLive;
	if (on) { e.type = Event::kNoteOnEvent; e.noteOn.channel = 0; e.noteOn.pitch = (int16)pitch; e.noteOn.velocity = velocity; e.noteOn.noteId = -1; }
	else { e.type = Event::kNoteOffEvent; e.noteOff.channel = 0; e.noteOff.pitch = (int16)pitch; e.noteOff.velocity = 0; e.noteOff.noteId = -1; }
	p->events.addEvent (e);
}

void v3_process (V3 *p, const float *const *in, float *const *out, int frames)
{
	if (!p || !p->active) { for (int c = 0; c < 2; c++) memset (out[c], 0, sizeof (float) * frames); return; }
	if (p->lock.try_lock ())
	{
		for (auto &e : p->pending) { int32 qi = 0, pi = 0; if (auto q = p->inParams.addParameterData (e.first, qi)) q->addPoint (0, e.second, pi); }
		p->pending.clear ();
		p->lock.unlock ();
	}
	for (int done = 0; done < frames;)
	{
		int n = std::min (frames - done, p->block);
		for (auto &b : p->ins) for (auto &ch : b.data) std::fill (ch.begin (), ch.begin () + n, 0.f);
		if (in && !p->ins.empty ()) for (int c = 0; c < p->ins[0].channels && c < 2; c++) memcpy (p->ins[0].data[c].data (), in[c] + done, sizeof (float) * n);
		for (size_t i = 0; i < p->outBufs.size (); i++) p->outBufs[i].silenceFlags = 0;
		ProcessContext ctx {};
		ctx.state = ProcessContext::kPlaying | ProcessContext::kTempoValid | ProcessContext::kTimeSigValid;
		ctx.sampleRate = p->sr; ctx.projectTimeSamples = p->pos; ctx.tempo = 120; ctx.timeSigNumerator = 4; ctx.timeSigDenominator = 4;
		ProcessData d {};
		d.processMode = kRealtime; d.symbolicSampleSize = kSample32; d.numSamples = n;
		d.numInputs = (int32)p->inBufs.size (); d.inputs = p->inBufs.empty () ? nullptr : p->inBufs.data ();
		d.numOutputs = (int32)p->outBufs.size (); d.outputs = p->outBufs.empty () ? nullptr : p->outBufs.data ();
		d.inputEvents = &p->events; d.outputEvents = &p->outEvents;
		d.inputParameterChanges = &p->inParams; d.outputParameterChanges = &p->outParams;
		d.processContext = &ctx;
		p->proc->process (d);
		p->events.clear (); p->outEvents.clear (); p->inParams.clearQueue (); p->outParams.clearQueue ();
		p->pos += n;
		for (int c = 0; c < 2; c++)
		{
			if (p->outs.empty () || p->outs[0].channels == 0) memset (out[c] + done, 0, sizeof (float) * n);
			else memcpy (out[c] + done, p->outs[0].data[std::min (c, p->outs[0].channels - 1)].data (), sizeof (float) * n);
		}
		done += n;
	}
}

int v3_open_view (V3 *p, void *nsview, int *width, int *height)
{
	if (!p || !p->ctrl) return 0;
	@autoreleasepool {
		v3_close_view (p);
		p->view = owned (p->ctrl->createView (ViewType::kEditor));
		if (!p->view || p->view->isPlatformTypeSupported (kPlatformTypeNSView) != kResultTrue) { p->view = nullptr; return 0; }
		p->host = (__bridge NSView *)nsview;
		p->view->setFrame (&p->handler);
		ViewRect r {};
		p->view->getSize (&r);
		if (width) *width = r.getWidth ();
		if (height) *height = r.getHeight ();
		[p->host setFrameSize:NSMakeSize (r.getWidth (), r.getHeight ())];
		if (p->view->attached (nsview, kPlatformTypeNSView) != kResultOk) { p->view->setFrame (nullptr); p->view = nullptr; p->host = nil; return 0; }
		return 1;
	}
}

void v3_close_view (V3 *p)
{
	if (!p || !p->view) return;
	p->view->setFrame (nullptr);
	p->view->removed ();
	p->view = nullptr; p->host = nil;
}

int v3_get_state (V3 *p, unsigned char **data, int *len)
{
	if (!p) return 0;
	MemoryStream cs, es;
	p->comp->getState (&cs);
	if (p->ctrl) p->ctrl->getState (&es);
	uint32_t cl = (uint32_t)cs.getSize (), el = (uint32_t)es.getSize ();
	auto buf = (unsigned char *)malloc (4 + cl + el);
	memcpy (buf, &cl, 4); memcpy (buf + 4, cs.getData (), cl); memcpy (buf + 4 + cl, es.getData (), el);
	*data = buf; *len = (int)(4 + cl + el);
	return 1;
}

int v3_set_state (V3 *p, const unsigned char *data, int len)
{
	if (!p || len < 4) return 0;
	uint32_t cl; memcpy (&cl, data, 4);
	if ((int64_t)cl + 4 > len) return 0;
	MemoryStream cs ((void *)(data + 4), cl), cs2 ((void *)(data + 4), cl), es ((void *)(data + 4 + cl), len - 4 - cl);
	p->comp->setState (&cs);
	if (p->ctrl) { p->ctrl->setComponentState (&cs2); if (len - 4 - cl > 0) p->ctrl->setState (&es); }
	return 1;
}

void v3_free (void *data) { free (data); }

}
