// STRATUM sound packs: tens of thousands of CC0 sounds too large to bundle. library/packs.json lists them, and each sound
// is streamed from its pinned source the first time it is used. A sound put on a track is saved inside the project.
(() => {
  const S = window.S, IO = S.io, NOTES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const GENRES = {
    Kicks: 'hip hop trap drill boom bap house techno edm dnb rock metal pop', Snares: 'hip hop trap drill boom bap rock punk metal pop funk jazz',
    Hats: 'hip hop trap drill house techno pop rock jazz', Claps: 'hip hop trap house pop reggaeton afrobeats gospel', Toms: 'rock metal punk jazz pop', Cymbals: 'rock metal punk jazz pop cinematic',
    Percussion: 'latin salsa reggaeton afrobeats amapiano dancehall house funk world', World: 'world afrobeats amapiano folk cinematic ambient',
    Bass: 'funk soul r&b rock punk metal reggae jazz pop gospel country', Guitar: 'rock punk metal indie blues country folk funk jazz r&b latin',
    'Piano and Keys': 'pop r&b soul gospel jazz house classical lo-fi', Organ: 'gospel soul blues reggae rock classical', Strings: 'classical cinematic r&b soul pop trap',
    Brass: 'classical cinematic funk soul jazz latin trap', Woodwinds: 'classical cinematic folk jazz lo-fi', Saxophone: 'jazz soul funk r&b lo-fi blues',
    'Mallets and Bells': 'cinematic classical ambient trap lo-fi', 'Harp and Plucked': 'classical cinematic folk world ambient', Vocals: 'house trance edm pop dance',
    Synths: 'edm house techno trance dnb dubstep synthwave pop ambient', '808s': 'trap drill hip hop boom bap r&b reggaeton', Pads: 'ambient cinematic r&b synthwave lo-fi', FX: 'edm trap cinematic house',
  };
  IO.GENRE_CHIPS = ['Hip hop', 'Trap', 'Drill', 'R&B', 'Soul', 'Gospel', 'Pop', 'House', 'Techno', 'Trance', 'DnB', 'Dubstep', 'Synthwave', 'Reggaeton', 'Afrobeats', 'Amapiano', 'Dancehall', 'Reggae', 'Latin', 'Salsa', 'Rock', 'Punk', 'Metal', 'Indie', 'Blues', 'Country', 'Folk', 'Jazz', 'Funk', 'Lo-fi', 'Classical', 'Cinematic', 'Ambient', 'World'];
  // The note a sound was played at, read from its file name (e3, Bb2, F#4), so it plays in tune across the keys.
  IO.noteOf = (name) => {
    const m = name.replace(/\.[^.]+$/, '').match(/(?:^|[^a-z0-9])([a-g])(#|b|s)?(-?[0-8])(?![0-9a-z])/i);
    if (!m) return null;
    const acc = !m[2] ? 0 : m[2] === 'b' ? -1 : 1;
    return 12 * (parseInt(m[3], 10) + 1) + NOTES[m[1].toLowerCase()] + acc;
  };
  const tag = (x) => { x.tags = GENRES[x.category] || ''; return x; };
  let list = null;
  // The bundled sounds and My Sounds, then every pack. Stand-ins for imported projects stay with IO.libList, the bundled sounds.
  IO.soundList = async () => {
    const own = (await IO.libList()).map(tag);
    if (list) return [...own, ...list];
    let packs = [];
    try { const ab = await IO.libRead('packs.json'); if (ab) packs = JSON.parse(new TextDecoder().decode(ab)); } catch (e) {}
    list = [];
    packs.forEach((p, i) => p.files.forEach(([path, category], j) => {
      const tail = path.split('/').slice(-3).join(' ').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      list.push(tag({ path: `pack:${i}:${j}`, name: `${p.name}: ${tail}`, category, collection: p.name + ' (CC0)', pack: true, root: IO.noteOf(path.split('/').pop()) }));
    }));
    IO._packs = packs;
    return [...own, ...list];
  };
  const libRead = IO.libRead;
  IO.libRead = async (path) => {
    if (!path.startsWith('pack:')) return libRead(path);
    const [, i, j] = path.split(':'), p = IO._packs[+i], url = p.base + p.files[+j][0].split('/').map(encodeURIComponent).join('/');
    const box = window.caches ? await caches.open('stratum-packs').catch(() => null) : null, hit = box && (await box.match(url).catch(() => null));
    if (hit) return hit.arrayBuffer();
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) { S.ui.toast('That sound needs an internet connection the first time it is used.', true); return null; }
    if (box) box.put(url, res.clone()).catch(() => {});
    return res.arrayBuffer();
  };
})();
