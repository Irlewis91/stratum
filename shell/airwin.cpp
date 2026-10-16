// STRATUM's link to Airwindows Consolidated (MIT licence, vendor/airwin2rack): registers every effect and exposes them
// through the C calls in airwin.h. Documentation lookup from the original registry is left out.
#include "airwin.h"
#include "AirwinRegistry.h"
#include <string>

std::vector<AirwinRegistry::awReg> AirwinRegistry::registry;
std::set<std::string> AirwinRegistry::categories;
std::vector<int> AirwinRegistry::fxAlphaOrdering;
std::vector<int> AirwinRegistry::fxChrisOrdering;
std::map<std::string, std::vector<std::string>> AirwinRegistry::fxByCategory;
std::map<std::string, std::vector<std::string>> AirwinRegistry::fxByCategoryChrisOrder;
std::unordered_map<std::string, int> AirwinRegistry::nameToIndex;
std::map<std::string, std::unordered_set<std::string>> AirwinRegistry::namesByCollection;

// The effects register themselves while the program starts, so this comes after the registry it fills.
#include "ModuleAdd.h"

namespace {
std::vector<std::string> &collections () { static std::vector<std::string> c; return c; }
bool ready ()
{
	static bool done = [] {
		AirwinRegistry::completeRegistry ();
		for (auto &r : AirwinRegistry::registry)
		{
			std::string s;
			for (auto &c : r.collections) s += (s.empty () ? "" : ",") + c;
			collections ().push_back (s);
		}
		return true;
	}();
	return done;
}
bool valid (int i) { return ready () && i >= 0 && i < (int)AirwinRegistry::registry.size (); }
}

extern "C" {
int aw_count (void) { return ready () ? (int)AirwinRegistry::registry.size () : 0; }
const char *aw_name (int i) { return valid (i) ? AirwinRegistry::registry[i].name.c_str () : ""; }
const char *aw_category (int i) { return valid (i) ? AirwinRegistry::registry[i].category.c_str () : ""; }
const char *aw_what (int i) { return valid (i) ? AirwinRegistry::registry[i].whatText.c_str () : ""; }
const char *aw_collections (int i) { return valid (i) ? collections ()[i].c_str () : ""; }

void *aw_create (const char *name, double sample_rate)
{
	if (!ready ()) return nullptr;
	auto it = AirwinRegistry::nameToIndex.find (name);
	if (it == AirwinRegistry::nameToIndex.end ()) return nullptr;
	auto fx = AirwinRegistry::registry[it->second].generator ().release ();
	if (fx) fx->setSampleRate ((float)sample_rate);
	return fx;
}
void aw_destroy (void *fx) { delete (AirwinConsolidatedBase *)fx; }
void aw_set_rate (void *fx, double sample_rate) { if (fx) ((AirwinConsolidatedBase *)fx)->setSampleRate ((float)sample_rate); }
int aw_params (void *fx)
{
	if (!fx) return 0;
	auto b = (AirwinConsolidatedBase *)fx;
	for (int i = 0; i < 64; i++) { char t[64] = {0}; b->getParameterName (i, t); if (!t[0]) return i; }
	return 64;
}
void aw_param_name (void *fx, int i, char *text, int len) { char t[256] = {0}; if (fx) ((AirwinConsolidatedBase *)fx)->getParameterName (i, t); snprintf (text, len, "%s", t); }
void aw_param_display (void *fx, int i, char *text, int len)
{
	char v[256] = {0}, u[256] = {0};
	if (fx) { ((AirwinConsolidatedBase *)fx)->getParameterDisplay (i, v); ((AirwinConsolidatedBase *)fx)->getParameterLabel (i, u); }
	std::string s = v;
	s.erase (0, s.find_first_not_of (' '));
	if (u[0]) s += std::string (" ") + u;
	snprintf (text, len, "%s", s.c_str ());
}
float aw_get (void *fx, int i) { return fx ? ((AirwinConsolidatedBase *)fx)->getParameter (i) : 0; }
void aw_set (void *fx, int i, float value) { if (fx) ((AirwinConsolidatedBase *)fx)->setParameter (i, value); }
void aw_process (void *fx, float **in, float **out, int frames) { if (fx) ((AirwinConsolidatedBase *)fx)->processReplacing (in, out, frames); }
}
