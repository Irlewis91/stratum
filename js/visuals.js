// STRATUM Visuals: audio-reactive visuals for the mix or any track. 11 categories of modes (WebGL shaders and canvas
// drawings), an effects chain (Glass, Dither, Texture, Track), your own image and lyric lines, presets, grids of up to 36
// tiles and a performance mode. Also used for Share videos and Go live.
(function () {
  const S = window.S;
  const V = (S.vis = {});

  // ---------------------------------------------------------------- audio features
  /** Reads an AnalyserNode each frame: waveform, spectrum, level, bass/mid/high and a beat pulse. */
  V.Analyzer = class {
    constructor(an) { this.an = an; this.wave = new Uint8Array(512); this.spec = new Uint8Array(256); this.f = { level: 0, bass: 0, mid: 0, high: 0, beat: 0, beats: 0 }; this.avg = 0.05; this.lastHit = 0; this.peak = 0.2; }
    read(now, gain, tempoBeat) {
      const an = this.an, f = this.f, n = an.frequencyBinCount, sr = an.context.sampleRate;
      const td = new Uint8Array(an.fftSize), fd = new Uint8Array(n);
      an.getByteTimeDomainData(td); an.getByteFrequencyData(fd);
      for (let i = 0; i < 512; i++) this.wave[i] = td[Math.floor((i * td.length) / 512)];
      // Spectrum on a log scale (40 Hz to 16 kHz) so bass, mids and highs get similar room.
      let top = 0; const raw = this.raw || (this.raw = new Float32Array(256));
      for (let i = 0; i < 256; i++) { const hz = 40 * Math.pow(400, i / 255), b = Math.min(n - 1, Math.round((hz * an.fftSize) / sr)); raw[i] = fd[b] * (0.75 + i / 512); top = Math.max(top, raw[i]); }
      this.specPk = Math.max(top, (this.specPk || 120) * 0.996, 60);
      // Shown relative to the recent loudest bin, with a little headroom, so the bars move instead of pinning at the top.
      for (let i = 0; i < 256; i++) this.spec[i] = Math.min(255, Math.max(0, (raw[i] / this.specPk - 0.25) / 0.8) * 255 * gain);
      const band = (lo, hi) => { let s = 0, c = 0; for (let i = Math.max(1, Math.floor((lo * an.fftSize) / sr)); i <= Math.min(n - 1, Math.ceil((hi * an.fftSize) / sr)); i++) { s += fd[i]; c++; } return c ? s / c / 255 : 0; };
      let rms = 0; for (let i = 0; i < td.length; i++) { const x = (td[i] - 128) / 128; rms += x * x; } rms = Math.sqrt(rms / td.length);
      const sm = (a, b, k) => a + (b - a) * k;
      // Each band is measured against its own recent peak, so quiet and loud mixes both move the visuals fully.
      this.pk = this.pk || { b: 0.3, m: 0.3, h: 0.2, l: 0.2 };
      const norm = (raw, k, floor) => { this.pk[k] = Math.max(raw, this.pk[k] * 0.996, floor); return Math.min(1, Math.pow(raw / this.pk[k], 1.6) * gain); };
      const bass = norm(band(30, 160), 'b', 0.12), mid = norm(band(160, 2400), 'm', 0.1), high = norm(band(2400, 14000), 'h', 0.05), lvl = norm(rms, 'l', 0.03);
      f.level = sm(f.level, lvl, 0.35); f.bass = sm(f.bass, bass, 0.45); f.mid = sm(f.mid, mid, 0.4); f.high = sm(f.high, high, 0.5);
      // Beat: STRATUM's own tempo while it plays, otherwise kick-drum onsets.
      let hit = false;
      if (tempoBeat != null) { const b = Math.floor(tempoBeat); if (b !== this.lastBeatNo) { hit = this.lastBeatNo != null; this.lastBeatNo = b; } }
      else { this.lastBeatNo = null; if (bass > this.avg * 1.35 + 0.08 && now - this.lastHit > 0.18) hit = true; this.avg = sm(this.avg, bass, 0.08); }
      if (hit) { this.lastHit = now; f.beat = 1; f.beats++; } else f.beat *= 0.86;
      return f;
    }
  };

  // ---------------------------------------------------------------- colours
  V.PALETTES = {
    Stratum: ['#0f1016', '#e39a12', '#ede9e0'], Ember: ['#1a0602', '#ff4d1a', '#ffd166'], Ocean: ['#020c1b', '#0aa2c0', '#b8f3ff'], Neon: ['#0b0016', '#ff2bd6', '#2bfff0'],
    Lime: ['#05140a', '#7dff3a', '#f4ffe0'], Sunset: ['#1b0b2e', '#ff5e62', '#ffb88c'], Ice: ['#06121f', '#6fb7ff', '#ffffff'], Gold: ['#120d02', '#c99a2e', '#fff1c1'],
    Acid: ['#000000', '#d4ff00', '#ff00a8'], Mono: ['#000000', '#888888', '#ffffff'], Phosphor: ['#010a03', '#16c60c', '#b6ff9e'], Amber: ['#0d0700', '#ffb000', '#ffe7a3'],
    Vapor: ['#1d0b3a', '#ff71ce', '#01cdfe'], Forest: ['#06110b', '#2f8f5b', '#d8f3dc'], Blood: ['#0a0000', '#b3001b', '#ff8a8a'], Sky: ['#0a1a33', '#5aa9e6', '#ffe45e'],
    Candy: ['#2b0f2e', '#ff8fab', '#a0e7e5'], Arcade: ['#000014', '#00e0ff', '#ffee00'], Rust: ['#140a05', '#c4512d', '#f2cc8f'], Lilac: ['#120a1f', '#9d79d6', '#f3e8ff'],
    Toxic: ['#020a02', '#39ff14', '#faff00'], Steel: ['#0b0f14', '#5c7080', '#d9e2ec'], Coral: ['#13070a', '#ff6f59', '#ffe0d6'], Midnight: ['#000000', '#3a0ca3', '#f72585'],
  };
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  const colorsOf = (p) => (p.colors && p.colors.length === 3 ? p.colors : V.PALETTES[p.palette] || V.PALETTES.Stratum);
  const palAt = (cols, t) => { t = ((t % 1) + 1) % 1; const [a, b] = t < 0.5 ? [cols[0], cols[1]] : [cols[1], cols[2]], k = t < 0.5 ? t * 2 : t * 2 - 1, A = rgb(a), B = rgb(b); return `rgb(${A.map((x, i) => Math.round((x + (B[i] - x) * k) * 255)).join(',')})`; };

  // ---------------------------------------------------------------- shaders
  const VS = 'attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
  const HEAD = `precision highp float;varying vec2 v;uniform vec2 uRes;uniform float uT,uLvl,uBass,uMid,uHigh,uBeat,uInt,uSize,uVar,uHasImg;
uniform vec3 uC1,uC2,uC3;uniform sampler2D uWave,uSpec,uImg;
float wave(float x){return texture2D(uWave,vec2(clamp(x,0.,1.),.5)).r*2.-1.;}
float spec(float x){return texture2D(uSpec,vec2(clamp(x,0.,1.),.5)).r;}
vec3 pal(float t){t=fract(t);return t<.5?mix(uC1,uC2,t*2.):mix(uC2,uC3,t*2.-1.);}
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*vn(p);p*=2.03;a*=.5;}return s;}
vec2 asp(){vec2 q=v-.5;q.x*=uRes.x/uRes.y;return q;}
vec3 img(vec2 uv){return texture2D(uImg,vec2(uv.x,1.-uv.y)).rgb;}
`;
  const out = (c) => `gl_FragColor=vec4(${c}*(.55+uInt*.9),1.);`;
  // Each GL mode is the body of main(); `uVar` picks the variant.
  const GL = {
    lava: `vec2 q=asp();float f=0.;for(int i=0;i<8;i++){float fi=float(i);vec2 c=vec2(sin(uT*.31*(1.+fi*.13)+fi*2.1)*.62,cos(uT*.23*(1.+fi*.11)+fi*1.7)*.38);
      float r=(.065+.025*sin(fi+uT*.5))*(.55+uSize*.9)*(1.+uBass*.35);f+=r*r/max(1e-4,dot(q-c,q-c));}
      float m=smoothstep(.85,1.05,f),core=smoothstep(1.3,5.,f);vec3 col;
      if(uVar<.5){col=mix(uC1*.6+uC2*.12*smoothstep(.2,.85,f),mix(uC2,uC3,core*.8),m);col+=uC3*core*uHigh*.4;}
      else if(uVar<1.5){float rim=smoothstep(.85,1.,f)*(1.-smoothstep(1.,1.25,f));col=uC1*.5+uC2*.18*m+mix(uC2,uC3,.5)*rim*1.6+uC3*core*.25;}
      else{float n=vn(q*6.+uT*.4);col=mix(uC1*.5,uC2,smoothstep(.3,1.1,f+n*.25));col=mix(col,uC3,smoothstep(1.6,4.,f)*.7);col+=uC3*pow(uHigh,2.)*vn(q*40.+uT*2.)*.4;}${out('col')}`,
    plasma: `vec2 q=asp();vec3 col;float t=uT;
      if(uVar<.5){vec2 p=q*(3.+uSize*7.);float s=sin(p.x+t)+sin(p.y*1.3+t*1.2)+sin((p.x+p.y)*.7+t*.8+uBass*3.)+sin(length(p+vec2(sin(t*.5),cos(t*.4))*2.)*1.5-t);col=pal(s*.125+.5+uMid*.25);}
      else if(uVar<1.5){col=uC1*.2;for(int i=0;i<6;i++){float fi=float(i);float y=wave(v.x*.5+fi*.08)*(.15+uBass*.25)+sin(v.x*(4.+fi)+t*(1.+fi*.2))*.12*(1.+uMid)+(fi-2.5)*.06*uSize*2.;col+=pal(fi/6.+t*.05)*.012/(abs(q.y-y)+.004);}}
      else if(uVar<2.5){vec2 p=q*(1.5+uSize*2.);vec2 w=vec2(fbm(p+t*.1),fbm(p+vec2(5.2,1.3)-t*.12));float f=fbm(p+w*(2.+uBass*4.));col=pal(f+t*.03)*(.35+f*1.2);}
      else{float d=length(q);float s=sin(d*(18.+uSize*40.)-t*4.+uBass*7.);col=pal(d*.8+t*.08)*smoothstep(0.,.95,s)*(1.15-d*.7)+uC3*uBeat*.25*smoothstep(.5,0.,d);}
      if(uHasImg>.5){vec2 e=vec2(2./uRes.x,0.);float l=dot(img(v),vec3(.33));float g=abs(l-dot(img(v+e.xy),vec3(.33)))+abs(l-dot(img(v+e.yx*uRes.x/uRes.y),vec3(.33)));col+=pal(t*.1+l)*smoothstep(.05,.3,g)*(1.+uBass*3.);}${out('col')}`,
    cosmos: `vec2 q=asp();vec3 col=vec3(0.);float t=uT;
      if(uVar<.5){for(int i=0;i<5;i++){float fi=float(i);float z=fract(fi*.2+t*.04*(1.+uLvl*4.));float s=mix(24.,.6,z);vec2 p=q*s+fi*13.;vec2 id=floor(p);vec2 g=fract(p)-.5;float h=h21(id);vec2 o=vec2(h,fract(h*7.))-.5;float d=length(g-o*.8);float b=smoothstep(.07*(1.-z)+.012,0.,d)*smoothstep(0.,.25,z)*step(.55,h);col+=pal(h+fi*.2)*b*(1.2+uHigh*3.);}col+=uC2*uBeat*.12*(1.-length(q));}
      else if(uVar<1.5){float f=fbm(q*(2.+uSize*3.)+vec2(t*.03,-t*.02));float g=fbm(q*4.+f*2.-t*.05);col=pal(f*.8+g*.4+t*.02)*pow(g,1.5)*(1.6+uBass*1.5);vec2 sp=floor(q*120.);col+=uC3*step(.997,h21(sp))*(.6+uHigh*2.);}
      else if(uVar<2.5){float d=length(q);float a=atan(q.y,q.x);float r=sin(d*40.-t*6.-uBass*8.)*.5+.5;col=pal(d+t*.1)*pow(r,6.)*(1.2-d)*(.5+uLvl*2.);col+=uC3*pow(max(0.,cos(a*8.+t)),40.)*(.2+uHigh)*(1.-d);col+=uC2*.06/(d+.02)*(.5+uBeat*2.);}
      else{vec2 p=q*(6.+uSize*10.);vec2 id=floor(p);vec2 g=fract(p)-.5;float b=0.;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 n=id+vec2(x,y);vec2 o=vec2(h21(n),h21(n+3.1))-.5+.3*vec2(sin(t+h21(n)*6.),cos(t*.8+h21(n)*5.));float d=length(g-vec2(x,y)-o);b+=.004/(d*d+.002)*step(.7,h21(n+9.));}col=pal(t*.05+length(q))*b*(.4+uHigh*2.);}${out('col')}`,
    tv: `vec2 uv=v;float t=floor(uT*24.);float line=floor(uv.y*uRes.y/2.);
      float jit=(h21(vec2(line,t))-.5)*.06*(uHigh+uBeat)*(uInt+.3);uv.x+=jit*step(.6,h21(vec2(floor(uv.y*20.),t)));
      if(uVar>1.5){uv.y=fract(uv.y+uT*.15*(1.+uLvl*2.));uv.x+=sin(uv.y*40.+uT*5.)*.004*(1.+uBass*4.);}
      vec3 base;if(uVar>.5&&uVar<1.5){float b=floor(uv.x*7.);base=vec3(b<1.||b==2.||b==4.||b==6.?.85:.1,b<4.?.85:.1,mod(b,2.)<.5?.85:.1);base=mix(base,pal(b/7.),.35);if(uv.y<.18)base=pal(uv.x+uT*.1)*.8;}
      else base=uHasImg>.5?img(uv):pal(uv.y+uT*.05)*.35;
      float n=h21(uv*uRes+t);vec3 col=mix(base,vec3(n),.25+uHigh*.5*uInt);
      col.r=mix(col.r,(uHasImg>.5?img(uv+vec2(.006,0.)).r:col.r),.5);
      col*=1.-step(.985-uLvl*.08,h21(vec2(floor(uv.y*30.),t)))*.9;col*=.85+.15*sin(uv.y*uRes.y*1.5);${out('col')}`,
    field: `vec3 col;float t=uT*.05;
      if(uVar<.5){col=pal(t+uLvl*.3)*(.4+uLvl*1.2);}
      else if(uVar<1.5){float y=v.y;float a=.33+uBass*.25,b=a+.33+uMid*.2;col=y<a?pal(t):y<b?pal(t+.33):pal(t+.66);col*=.6+.6*(y<a?uBass:y<b?uMid:uHigh);col*=smoothstep(0.,.02,abs(y-a))*smoothstep(0.,.02,abs(y-b))*.3+.7;}
      else if(uVar<2.5){float n=floor(v.x*(4.+uSize*20.));float s=spec((n+.5)/(4.+uSize*20.));col=pal(n*.07+t)*(.25+s*1.2);}
      else if(uVar<3.5){vec2 c=floor(v*2.);float k=c.x+c.y*2.;float e=k<.5?uBass:k<1.5?uMid:k<2.5?uHigh:uLvl;col=pal(k*.25+t)*(.25+e*1.3);}
      else{float d=length(asp());float r=floor(d*(4.+uSize*8.)-uBass*2.);col=pal(r*.13+t)*(.5+.6*fract(r*.5)*(.5+uLvl));}${out('col')}`,
    pixel: `float cols=floor(12.+uSize*70.);vec2 cell=vec2(cols,floor(cols*uRes.y/uRes.x));vec2 g=floor(v*cell)/cell;vec3 col;
      if(uVar<.5){float s=spec(g.x+.5/cell.x);vec2 fc=fract(v*cell);float gap=step(.14,fc.x)*step(.14,fc.y);col=(g.y<s?pal(.35+g.y*.65):uC1*.6+uC2*.06)*gap;}
      else if(uVar<1.5){vec2 q=g-.5;q.x*=uRes.x/uRes.y;float d=length(q);float a=atan(q.y,q.x);float z=.3/max(d,.02)+uT*(1.+uBass*2.);col=pal(floor((fract(z*.5)+floor(a*3.)/6.)*4.)/4.+uT*.1)*smoothstep(0.,.25,d)*(.6+uLvl);}
      else{float h=.3+.25*wave(g.x)+.15*sin(g.x*6.+uT);float h2=.15+.1*sin(g.x*13.-uT*2.)+uBass*.1;col=g.y<h2?pal(.7):g.y<h?pal(.4+uMid*.2):pal(.05)+uC3*step(.995,h21(g*99.))*uHigh;}
      col=floor(col*4.)/4.;${out('col')}`,
  };

  // ---------------------------------------------------------------- canvas modes
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*+=<>/\\|:;'.split('');
  const C2 = {
    // Scope: 0 line, 1 circle, 2 mirror, 3 XY, 4 bars, 5 radial, 6 shape (polygon)
    scope(g, w, h, f, P, st, A) {
      g.fillStyle = `rgba(0,0,0,${0.12 + (1 - P.trail) * 0.8})`; g.fillRect(0, 0, w, h);
      const C = colorsOf(P), wv = A.wave, sp = A.spec, k = Math.min(w, h), lw = Math.max(1.5, k * 0.006 * (0.6 + P.size));
      g.lineWidth = lw; g.lineJoin = 'round'; g.shadowBlur = k * 0.03 * P.intensity; g.shadowColor = C[1]; g.strokeStyle = palAt(C, 0.55 + f.level * 0.4);
      const amp = (h / 2) * (0.3 + P.intensity * 0.9), V0 = P.variant;
      g.beginPath();
      if (V0 === 0 || V0 === 2) for (let i = 0; i < 512; i += 2) { const x = (i / 511) * w, y = h / 2 + ((wv[i] - 128) / 128) * amp * (V0 === 2 ? 0.5 : 1); i ? g.lineTo(x, V0 === 2 ? h / 4 + (y - h / 2) : y) : g.moveTo(x, y); }
      if (V0 === 2) { g.stroke(); g.beginPath(); for (let i = 0; i < 512; i += 2) { const x = (i / 511) * w, y = (3 * h) / 4 - ((wv[i] - 128) / 128) * amp * 0.5; i ? g.lineTo(x, y) : g.moveTo(x, y); } }
      if (V0 === 1 || V0 === 6) { const sides = V0 === 6 ? 3 + (Math.floor(st.t * 0.2) % 5) : 0; for (let i = 0; i <= 512; i += 2) { const a = (i / 512) * Math.PI * 2 + st.t * 0.2, r0 = k * (0.22 + P.size * 0.1) * (1 + f.bass * 0.3), poly = sides ? Math.cos(Math.PI / sides) / Math.cos(((a % ((2 * Math.PI) / sides)) - Math.PI / sides)) : 1, r = r0 * poly + ((wv[i % 512] - 128) / 128) * k * 0.15 * P.intensity; const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); }
      if (V0 === 3) for (let i = 0; i < 512; i++) { const x = w / 2 + ((wv[i] - 128) / 128) * k * 0.45 * P.intensity, y = h / 2 + ((wv[(i + 37) % 512] - 128) / 128) * k * 0.45 * P.intensity; i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
      if (V0 === 4) { const n = 64, bw = w / n; for (let i = 0; i < n; i++) { const v = sp[i * 4] / 255, bh = v * h * 0.9 * (0.5 + P.intensity * 0.6); g.fillStyle = palAt(C, 0.3 + v * 0.7); g.fillRect(i * bw + bw * 0.1, h - bh, bw * 0.8, bh); } }
      if (V0 === 5) { const n = 96; for (let i = 0; i < n; i++) { const v = sp[Math.floor((i / n) * 255)] / 255, a = (i / n) * Math.PI * 2 + st.t * 0.1, r0 = k * 0.18, r1 = r0 + v * k * 0.32 * (0.5 + P.intensity); g.strokeStyle = palAt(C, 0.3 + v * 0.7); g.beginPath(); g.moveTo(w / 2 + Math.cos(a) * r0, h / 2 + Math.sin(a) * r0); g.lineTo(w / 2 + Math.cos(a) * r1, h / 2 + Math.sin(a) * r1); g.stroke(); } }
      g.shadowBlur = 0;
    },
    // Arcade: 0 Breaker, 1 Invasion, 2 Serpent, 3 Rally, 4 Rocks
    arcade(g, w, h, f, P, st, A) {
      const C = colorsOf(P), V0 = P.variant, px = Math.max(2, Math.floor(Math.min(w, h) / 90));
      g.fillStyle = C[0]; g.fillRect(0, 0, w, h); g.imageSmoothingEnabled = false;
      const block = (x, y, s, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), s, s); };
      st.ball = st.ball || { x: w / 2, y: h * 0.7, vx: 1, vy: -1 };
      const B = st.ball, sp = A.spec, speed = (2 + f.level * 10) * (Math.min(w, h) / 400);
      if (V0 === 0) {
        const cols = 14, rows = 6, bw = w / cols, bh = h * 0.05;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const e = sp[Math.floor((c / cols) * 250)] / 255; if (e > (r + 1) / (rows + 2)) { g.fillStyle = palAt(C, 0.3 + r / rows * 0.7); g.fillRect(c * bw + 2, h * 0.08 + r * bh + 2, bw - 4, bh - 4); } }
        const padX = w / 2 + Math.sin(st.t * 0.9) * w * 0.3 * (0.4 + f.mid), pw = w * 0.16;
        g.fillStyle = C[2]; g.fillRect(padX - pw / 2, h * 0.9, pw, px * 3);
        B.x += B.vx * speed; B.y += B.vy * speed;
        if (B.x < 0 || B.x > w) B.vx *= -1; if (B.y < h * 0.08 + rows * bh || f.beat > 0.95) B.vy = Math.abs(B.vy); if (B.y > h * 0.9) { B.vy = -Math.abs(B.vy); B.x = Math.max(0, Math.min(w, B.x)); }
        block(B.x, B.y, px * 3, C[2]);
      } else if (V0 === 1) {
        const sprite = ['00100100', '00011000', '01111110', '11011011', '11111111', '10111101', '10100101', '00011000'];
        const rows = 4, cols = 8, s = px * 1.4, gw = 8 * s * 1.6, step = Math.floor(st.beats) % 2, ox = (w - cols * gw) / 2 + (step ? gw * 0.25 : -gw * 0.25);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const e = sp[Math.floor((c / cols) * 240)] / 255, lift = e * s * 6, col = palAt(C, 0.35 + r * 0.15 + e * 0.3);
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (sprite[(y + (step && y > 5 ? 0 : 0)) % 8][x] === '1') block(ox + c * gw + x * s, h * 0.12 + r * gw * 0.9 + y * s - lift, Math.ceil(s), col);
        }
        const gx = w / 2 + Math.sin(st.t) * w * 0.35; g.fillStyle = C[2]; g.fillRect(gx - s * 4, h * 0.9, s * 8, s * 2); g.fillRect(gx - s, h * 0.9 - s * 2, s * 2, s * 2);
        if (f.beat > 0.9) st.shots = (st.shots || []).concat([{ x: gx, y: h * 0.88 }]);
        st.shots = (st.shots || []).filter((o) => (o.y -= speed * 3) > 0); for (const o of st.shots) block(o.x - s / 2, o.y, Math.ceil(s), C[2]);
      } else if (V0 === 2) {
        const gs = Math.max(8, Math.floor(Math.min(w, h) / 28)), gx = Math.floor(w / gs), gy = Math.floor(h / gs);
        st.snake = st.snake || [{ x: 5, y: 5 }]; st.dir = st.dir || { x: 1, y: 0 }; st.acc = (st.acc || 0) + 0.15 + f.level * 0.8;
        while (st.acc > 1) {
          st.acc -= 1; const hd = st.snake[0], target = { x: Math.floor((sp.indexOf(Math.max(...sp)) / 255) * gx), y: Math.floor(gy * (1 - f.bass) * 0.9) };
          if (Math.random() < 0.3) st.dir = Math.abs(target.x - hd.x) > Math.abs(target.y - hd.y) ? { x: Math.sign(target.x - hd.x) || 1, y: 0 } : { x: 0, y: Math.sign(target.y - hd.y) || 1 };
          st.snake.unshift({ x: (hd.x + st.dir.x + gx) % gx, y: (hd.y + st.dir.y + gy) % gy });
          while (st.snake.length > 6 + Math.floor(f.level * 40)) st.snake.pop();
        }
        st.snake.forEach((s, i) => { g.fillStyle = palAt(C, 0.4 + (i / st.snake.length) * 0.6); g.fillRect(s.x * gs + 1, s.y * gs + 1, gs - 2, gs - 2); });
        if (f.beat > 0.9) st.food = { x: Math.floor(Math.random() * gx), y: Math.floor(Math.random() * gy) };
        if (st.food) { g.fillStyle = C[2]; g.fillRect(st.food.x * gs + gs * 0.25, st.food.y * gs + gs * 0.25, gs / 2, gs / 2); }
      } else if (V0 === 3) {
        const ph = h * 0.22, pw = px * 3, l = h / 2 + (f.bass - 0.4) * h * 0.8, r = h / 2 + (f.high - 0.3) * h * 0.9;
        g.fillStyle = C[1]; for (let y = 0; y < h; y += px * 4) g.fillRect(w / 2 - px / 2, y, px, px * 2);
        g.fillStyle = C[2]; g.fillRect(w * 0.05, l - ph / 2, pw, ph); g.fillRect(w * 0.95 - pw, r - ph / 2, pw, ph);
        B.x += B.vx * speed * 1.4; B.y += B.vy * speed;
        if (B.y < 0 || B.y > h) B.vy *= -1; if (B.x < w * 0.06 || B.x > w * 0.94) { B.vx *= -1; st.flash = 1; }
        block(B.x, B.y, px * 3, C[2]); st.flash = (st.flash || 0) * 0.9;
        g.font = `${px * 10}px monospace`; g.textAlign = 'center'; g.fillStyle = palAt(C, 0.6); g.fillText(String(Math.floor(st.beats) % 100).padStart(2, '0'), w * 0.4, px * 14); g.fillText(String(Math.floor(st.t) % 100).padStart(2, '0'), w * 0.6, px * 14);
      } else {
        st.rocks = st.rocks || Array.from({ length: 7 }, () => ({ x: Math.random() * w, y: Math.random() * h, r: 20 + Math.random() * 40, a: Math.random() * 6, vx: Math.random() - 0.5, vy: Math.random() - 0.5, n: 7 + Math.floor(Math.random() * 4), s: Math.random() }));
        if (f.beat > 0.95 && st.rocks.length < 24) { const o = st.rocks[Math.floor(Math.random() * st.rocks.length)]; if (o.r > 14) { o.r *= 0.6; st.rocks.push({ ...o, vx: -o.vy * 1.5, vy: o.vx * 1.5, s: Math.random() }); } }
        if (st.rocks.length > 20 && Math.random() < 0.02) st.rocks.shift();
        g.lineWidth = Math.max(1.5, px * 0.7); g.shadowBlur = 8; g.shadowColor = C[1];
        for (const o of st.rocks) {
          o.x = (o.x + o.vx * speed + w) % w; o.y = (o.y + o.vy * speed + h) % h; o.a += 0.01 + f.mid * 0.05;
          g.strokeStyle = palAt(C, 0.5 + o.s * 0.5); g.beginPath();
          for (let i = 0; i <= o.n; i++) { const a = o.a + (i / o.n) * Math.PI * 2, rr = o.r * (Math.min(w, h) / 500) * (0.75 + 0.25 * Math.sin(i * 2.7 + o.s * 9)) * (1 + f.bass * 0.4); const x = o.x + Math.cos(a) * rr, y = o.y + Math.sin(a) * rr; i ? g.lineTo(x, y) : g.moveTo(x, y); }
          g.stroke();
        }
        g.shadowBlur = 0;
      }
    },
    // Code: 0 rain, 1 binary, 2 hex dump, 3 terminal
    code(g, w, h, f, P, st, A) {
      const C = colorsOf(P), V0 = P.variant, fs = Math.max(10, Math.floor(Math.min(w, h) / (18 + (1 - P.size) * 30)));
      g.font = `${fs}px ui-monospace, Menlo, Consolas, monospace`; g.textBaseline = 'top';
      if (V0 <= 1) {
        g.fillStyle = `rgba(0,0,0,${0.08 + (1 - P.trail) * 0.4})`; g.fillRect(0, 0, w, h);
        const cols = Math.ceil(w / fs); st.drops = st.drops && st.drops.length === cols ? st.drops : Array.from({ length: cols }, () => Math.random() * -50);
        for (let i = 0; i < cols; i++) {
          const e = A.spec[Math.floor((i / cols) * 255)] / 255; st.drops[i] += 0.25 + e * 1.5 * P.intensity + f.beat * 0.5;
          const y = st.drops[i] * fs, ch = V0 ? (Math.random() < 0.5 ? '0' : '1') : CHARS[Math.floor(Math.random() * CHARS.length)];
          g.fillStyle = e > 0.6 ? C[2] : palAt(C, 0.4 + e * 0.5); g.fillText(ch, i * fs, y);
          if (y > h && Math.random() > 0.96 - e * 0.1) st.drops[i] = Math.random() * -10;
        }
      } else if (V0 === 2) {
        g.fillStyle = C[0]; g.fillRect(0, 0, w, h);
        const cols = Math.floor(w / (fs * 2.4)), rows = Math.floor(h / (fs * 1.3));
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const b = A.spec[(r * cols + c + Math.floor(st.t * 8)) % 256]; g.fillStyle = b > 160 ? C[2] : palAt(C, 0.25 + (b / 255) * 0.6); g.fillText(b.toString(16).padStart(2, '0').toUpperCase(), c * fs * 2.4 + fs * 0.4, r * fs * 1.3 + fs * 0.3); }
      } else {
        g.fillStyle = C[0]; g.fillRect(0, 0, w, h);
        st.lines = st.lines || []; st.acc = (st.acc || 0) + 0.1 + f.level;
        if (st.acc > 1.5 || f.beat > 0.95) { st.acc = 0; const p = S.proj || {}; const words = [`> kick ${f.bass.toFixed(2)}  mids ${f.mid.toFixed(2)}  air ${f.high.toFixed(2)}`, `> ${p.name || 'untitled'} @ ${Math.round(p.bpm || 120)} bpm`, `> beat ${st.beats}  level ${(f.level * 100).toFixed(0)}%`, `> rendering layer ${Math.floor(Math.random() * 99)} ... ok`, `> STRATUM visual engine // ${new Date().toLocaleTimeString()}`]; st.lines.push(words[Math.floor(Math.random() * words.length)]); }
        const rows = Math.floor(h / (fs * 1.4)); st.lines = st.lines.slice(-rows);
        st.lines.forEach((l, i) => { g.fillStyle = i === st.lines.length - 1 ? C[2] : palAt(C, 0.45); g.fillText(l, fs, fs + i * fs * 1.4); });
        if (Math.floor(st.t * 2) % 2) { g.fillStyle = C[2]; g.fillRect(fs + g.measureText(st.lines[st.lines.length - 1] || '').width + 4, fs + (st.lines.length - 1) * fs * 1.4, fs * 0.6, fs); }
      }
    },
    // Text: 0 pulse, 1 glitch, 2 warp, 3 scroll, 4 stack
    text(g, w, h, f, P, st) {
      const C = colorsOf(P), V0 = P.variant, line = V.currentLine(P, st) || ' ';
      g.fillStyle = C[0]; g.fillRect(0, 0, w, h);
      const font = (px) => `800 ${px}px ${P.font || '-apple-system, "Segoe UI", system-ui, sans-serif'}`;
      let px = Math.min(h * 0.35, (w * 0.9) / Math.max(3, line.length * 0.6)) * (0.6 + P.size * 0.6);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (V0 === 0) { px *= 1 + f.bass * 0.35 * P.intensity + f.beat * 0.1; g.font = font(px); g.shadowBlur = px * 0.3 * f.level; g.shadowColor = C[1]; g.fillStyle = palAt(C, 0.6 + f.level * 0.4); g.fillText(line, w / 2, h / 2); g.shadowBlur = 0; }
      else if (V0 === 1) {
        g.font = font(px); const off = (f.beat * 0.04 + f.high * 0.02) * w * P.intensity;
        g.globalCompositeOperation = 'lighter'; g.fillStyle = '#ff0040'; g.fillText(line, w / 2 - off, h / 2); g.fillStyle = '#00e5ff'; g.fillText(line, w / 2 + off, h / 2); g.fillStyle = palAt(C, 0.8); g.fillText(line, w / 2, h / 2); g.globalCompositeOperation = 'source-over';
        const slices = Math.floor(f.beat * 8 * P.intensity); for (let i = 0; i < slices; i++) { const y = Math.random() * h, sh = Math.random() * h * 0.08; g.drawImage(g.canvas, 0, y, w, sh, (Math.random() - 0.5) * w * 0.1, y, w, sh); }
      } else if (V0 === 2) {
        g.font = font(px); const total = g.measureText(line).width; let x = w / 2 - total / 2;
        for (let i = 0; i < line.length; i++) { const ch = line[i], cw = g.measureText(ch).width, y = h / 2 + Math.sin(st.t * 3 + i * 0.5) * px * 0.3 * (0.3 + f.mid * P.intensity * 2); g.fillStyle = palAt(C, 0.4 + i / line.length * 0.6); g.save(); g.translate(x + cw / 2, y); g.rotate(Math.sin(st.t * 2 + i) * 0.15 * f.high); g.fillText(ch, 0, 0); g.restore(); x += cw; }
      } else if (V0 === 3) {
        px = h * 0.4 * (0.5 + P.size * 0.6); g.font = font(px); const tw = g.measureText(line + '   ').width; st.sx = ((st.sx || 0) + (2 + f.level * 12) * (w / 800)) % tw;
        g.textAlign = 'left'; g.fillStyle = palAt(C, 0.7 + f.bass * 0.3); for (let x = -st.sx; x < w; x += tw) g.fillText(line, x, h / 2);
      } else {
        const rows = 7, rh = h / rows; g.font = font(rh * 0.8);
        for (let r = 0; r < rows; r++) { const e = A_spec(r / rows); g.fillStyle = palAt(C, r / rows + st.t * 0.05); g.globalAlpha = 0.25 + e * 0.75; g.fillText(line, w / 2 + Math.sin(st.t + r) * w * 0.05 * f.mid, rh * (r + 0.5)); }
        g.globalAlpha = 1;
      }
      function A_spec(x) { return (V._lastSpec ? V._lastSpec[Math.floor(x * 255)] : 0) / 255; }
    },
    // Cosmos 4: constellation (canvas)
    constellation(g, w, h, f, P, st) {
      const C = colorsOf(P); g.fillStyle = C[0]; g.fillRect(0, 0, w, h);
      st.pts = st.pts || Array.from({ length: 70 }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, s: Math.random() }));
      const reach = Math.min(w, h) * (0.12 + P.size * 0.15) * (1 + f.bass * 0.5);
      for (const p of st.pts) { p.x = (p.x + p.vx * (1 + f.level * 6) + w) % w; p.y = (p.y + p.vy * (1 + f.level * 6) + h) % h; }
      g.lineWidth = 1;
      for (let i = 0; i < st.pts.length; i++) for (let j = i + 1; j < st.pts.length; j++) { const a = st.pts[i], b = st.pts[j], d = Math.hypot(a.x - b.x, a.y - b.y); if (d < reach) { g.strokeStyle = palAt(C, 0.4 + a.s * 0.4); g.globalAlpha = (1 - d / reach) * (0.3 + f.high); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); } }
      g.globalAlpha = 1;
      for (const p of st.pts) { g.fillStyle = palAt(C, 0.7 + p.s * 0.3); const r = 1.5 + p.s * 2.5 * (1 + f.beat); g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill(); }
    },
  };

  // ---------------------------------------------------------------- catalogue
  const M = (cat, name, kind, key, variant) => ({ cat, name, kind, key, variant });
  V.MODES = [
    M('Scope', 'Phosphor line', '2d', 'scope', 0), M('Scope', 'Ring', '2d', 'scope', 1), M('Scope', 'Mirror', '2d', 'scope', 2), M('Scope', 'X–Y figure', '2d', 'scope', 3), M('Scope', 'Shape', '2d', 'scope', 6),
    M('Lava', 'Lamp', 'gl', 'lava', 0), M('Lava', 'Bubbles', 'gl', 'lava', 1), M('Lava', 'Melt', 'gl', 'lava', 2),
    M('Arcade', 'Breaker', '2d', 'arcade', 0), M('Arcade', 'Invasion', '2d', 'arcade', 1), M('Arcade', 'Serpent', '2d', 'arcade', 2), M('Arcade', 'Rally', '2d', 'arcade', 3), M('Arcade', 'Rocks', '2d', 'arcade', 4),
    M('Cosmos', 'Warp', 'gl', 'cosmos', 0), M('Cosmos', 'Nebula', 'gl', 'cosmos', 1), M('Cosmos', 'Pulsar', 'gl', 'cosmos', 2), M('Cosmos', 'Fireflies', 'gl', 'cosmos', 3), M('Cosmos', 'Constellation', '2d', 'constellation', 0),
    M('Code', 'Glyph rain', '2d', 'code', 0), M('Code', 'Binary', '2d', 'code', 1), M('Code', 'Hex dump', '2d', 'code', 2), M('Code', 'Terminal', '2d', 'code', 3),
    M('Color Field', 'Wash', 'gl', 'field', 0), M('Color Field', 'Bands', 'gl', 'field', 1), M('Color Field', 'Stripes', 'gl', 'field', 2), M('Color Field', 'Quarters', 'gl', 'field', 3), M('Color Field', 'Target', 'gl', 'field', 4),
    M('TV', 'Static', 'gl', 'tv', 0), M('TV', 'Test card', 'gl', 'tv', 1), M('TV', 'Rolling', 'gl', 'tv', 2),
    M('Pixel', 'Equalizer', 'gl', 'pixel', 0), M('Pixel', 'Tunnel', 'gl', 'pixel', 1), M('Pixel', 'Landscape', 'gl', 'pixel', 2),
    M('Text', 'Pulse', '2d', 'text', 0), M('Text', 'Glitch', '2d', 'text', 1), M('Text', 'Wave', '2d', 'text', 2), M('Text', 'Marquee', '2d', 'text', 3), M('Text', 'Stack', '2d', 'text', 4),
    M('Plasma', 'Classic', 'gl', 'plasma', 0), M('Plasma', 'Light beams', 'gl', 'plasma', 1), M('Plasma', 'Liquid', 'gl', 'plasma', 2), M('Plasma', 'Ripples', 'gl', 'plasma', 3),
    M('Spectrum', 'Bars', '2d', 'scope', 4), M('Spectrum', 'Radial', '2d', 'scope', 5),
  ];
  V.CATS = [...new Set(V.MODES.map((m) => m.cat))];
  V.FX = { glass: ['Off', 'Ball', '2×2', 'Kaleido', 'Flower', 'Cross', 'Burst'], dither: ['Off', 'Symbol', 'Star', 'Flower', 'Hex'], texture: ['Off', 'Noise', 'Grain', 'CRT', 'Threshold'], track: ['Off', 'Basic', 'System', 'Bracket', 'Glow', 'Terminal'] };
  V.IMAGE_USE = ['Behind', 'Outline', 'Pulse'];

  V.defaults = () => ({ mode: 'Lava/Lamp', palette: 'Stratum', colors: null, intensity: 0.6, speed: 0.5, size: 0.5, trail: 0.4, gain: 1, variant: 0,
    fx: { glass: [0, 0.6], dither: [0, 0.6], texture: [0, 0.5], track: [0, 0.7] }, imageUse: 1, text: '', textCue: 'bar', font: '' });
  const P0 = (o) => Object.assign(V.defaults(), o, { fx: Object.assign(V.defaults().fx, o.fx || {}) });
  V.FACTORY = {
    'Warm Lamp': P0({ mode: 'Lava/Lamp', palette: 'Ember' }), 'Bubble Bath': P0({ mode: 'Lava/Bubbles', palette: 'Ocean', fx: { glass: [1, 0.4] } }), 'Molten': P0({ mode: 'Lava/Melt', palette: 'Sunset', intensity: 0.8 }),
    'Green Screen': P0({ mode: 'Scope/Phosphor line', palette: 'Phosphor', trail: 0.8, fx: { texture: [3, 0.8] } }), 'Halo': P0({ mode: 'Scope/Ring', palette: 'Stratum', trail: 0.6 }), 'Twin Scope': P0({ mode: 'Scope/Mirror', palette: 'Amber', fx: { texture: [3, 0.6] } }),
    'Lissajous': P0({ mode: 'Scope/X–Y figure', palette: 'Neon', trail: 0.85 }), 'Shapeshifter': P0({ mode: 'Scope/Shape', palette: 'Vapor', fx: { glass: [3, 0.5] } }),
    'Brick Party': P0({ mode: 'Arcade/Breaker', palette: 'Arcade', fx: { texture: [3, 0.7] } }), 'Invaders From The Mix': P0({ mode: 'Arcade/Invasion', palette: 'Toxic', fx: { texture: [3, 0.6] } }),
    'Snake Charmer': P0({ mode: 'Arcade/Serpent', palette: 'Lime' }), 'Rally Point': P0({ mode: 'Arcade/Rally', palette: 'Mono', fx: { texture: [3, 0.8] } }), 'Vector Field': P0({ mode: 'Arcade/Rocks', palette: 'Ice' }),
    'Hyperdrive': P0({ mode: 'Cosmos/Warp', palette: 'Ice', speed: 0.7 }), 'Nebula Drift': P0({ mode: 'Cosmos/Nebula', palette: 'Midnight' }), 'Pulsar': P0({ mode: 'Cosmos/Pulsar', palette: 'Gold', fx: { glass: [6, 0.4] } }),
    'Fireflies': P0({ mode: 'Cosmos/Fireflies', palette: 'Forest' }), 'Star Map': P0({ mode: 'Cosmos/Constellation', palette: 'Sky', fx: { track: [2, 0.6] } }),
    'Digital Rain': P0({ mode: 'Code/Glyph rain', palette: 'Phosphor', trail: 0.7 }), 'Ones and Zeros': P0({ mode: 'Code/Binary', palette: 'Arcade' }), 'Hexadecimal': P0({ mode: 'Code/Hex dump', palette: 'Amber', fx: { texture: [3, 0.5] } }),
    'Mainframe': P0({ mode: 'Code/Terminal', palette: 'Phosphor', fx: { texture: [3, 0.9] } }),
    'Mood Wash': P0({ mode: 'Color Field/Wash', palette: 'Candy' }), 'Gallery': P0({ mode: 'Color Field/Bands', palette: 'Rust' }), 'Barcode': P0({ mode: 'Color Field/Stripes', palette: 'Neon' }),
    'Four Squares': P0({ mode: 'Color Field/Quarters', palette: 'Sunset' }), 'Bullseye': P0({ mode: 'Color Field/Target', palette: 'Stratum', fx: { dither: [4, 0.5] } }),
    'Dead Channel': P0({ mode: 'TV/Static', palette: 'Mono' }), 'Test Pattern': P0({ mode: 'TV/Test card', palette: 'Stratum', fx: { texture: [3, 0.6] } }), 'Vertical Hold': P0({ mode: 'TV/Rolling', palette: 'Lilac' }),
    '8-Bit EQ': P0({ mode: 'Pixel/Equalizer', palette: 'Arcade', size: 0.3 }), 'Pixel Tunnel': P0({ mode: 'Pixel/Tunnel', palette: 'Vapor' }), 'Side Scroller': P0({ mode: 'Pixel/Landscape', palette: 'Sky' }),
    'Title Pulse': P0({ mode: 'Text/Pulse', palette: 'Stratum' }), 'Corrupted': P0({ mode: 'Text/Glitch', palette: 'Mono', fx: { texture: [1, 0.4] } }), 'Ocean Letters': P0({ mode: 'Text/Wave', palette: 'Ocean' }),
    'Ticker': P0({ mode: 'Text/Marquee', palette: 'Amber' }), 'Echo Chamber': P0({ mode: 'Text/Stack', palette: 'Neon' }),
    'Old School Plasma': P0({ mode: 'Plasma/Classic', palette: 'Neon' }), 'Light Show': P0({ mode: 'Plasma/Light beams', palette: 'Vapor' }), 'Liquid Glow': P0({ mode: 'Plasma/Liquid', palette: 'Toxic' }),
    'Rain on Water': P0({ mode: 'Plasma/Ripples', palette: 'Ocean' }), 'Skyline EQ': P0({ mode: 'Spectrum/Bars', palette: 'Stratum' }), 'Sunburst': P0({ mode: 'Spectrum/Radial', palette: 'Gold', fx: { glass: [3, 0.3] } }),
    'Stained Glass': P0({ mode: 'Plasma/Liquid', palette: 'Candy', fx: { glass: [4, 0.8], dither: [4, 0.4] } }), 'Star Stitch': P0({ mode: 'Lava/Melt', palette: 'Lilac', fx: { dither: [2, 0.8] } }),
    'Surveillance': P0({ mode: 'Cosmos/Fireflies', palette: 'Mono', fx: { track: [2, 0.8], texture: [2, 0.6] } }), 'Prism': P0({ mode: 'Plasma/Ripples', palette: 'Ice', fx: { glass: [2, 0.8] } }),
    'Threshold': P0({ mode: 'Plasma/Liquid', palette: 'Blood', fx: { texture: [4, 0.8] } }), 'Embroidery': P0({ mode: 'Color Field/Stripes', palette: 'Forest', fx: { dither: [3, 0.9] } }),
  };
  V.modeOf = (key) => V.MODES.find((m) => m.cat + '/' + m.name === key) || V.MODES[5];

  // ---------------------------------------------------------------- text lines
  V.currentLine = (P, st) => {
    const lines = (P.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return (S.proj && S.proj.name) || 'STRATUM';
    if (P.textCue === 'manual') return lines[(V.manualLine || 0) % lines.length];
    const per = P.textCue === 'beat' ? 1 : P.textCue === 'bar' ? 4 : 16;
    return lines[Math.floor((st.beats || 0) / per) % lines.length];
  };

  // ---------------------------------------------------------------- renderer
  /** Draws visuals for one or more tiles onto a WebGL canvas. */
  V.Renderer = class {
    constructor(canvas) {
      this.cv = canvas;
      const gl = (this.gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }));
      if (!gl) throw new Error('This device does not support WebGL.');
      this.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.progs = {}; this.tiles = []; this.waveTex = this.tex(); this.specTex = this.tex(); this.imgTex = this.tex(); this.hasImg = false;
      this.c2 = document.createElement('canvas'); this.g2 = this.c2.getContext('2d');
      this.probe = new Uint8Array(32 * 18 * 4);
      this.fxSrc = `uniform sampler2D uSrc;uniform float uGlass,uGlassK,uDith,uDithK,uTex,uTexK,uFlash,uShake,uInvert,uBlack;
vec4 S0(vec2 p){return texture2D(uSrc,p);}
vec3 glass(vec2 uv){vec2 c=uv-.5;float ar=uRes.x/uRes.y;c.x*=ar;float r=length(c),a=atan(c.y,c.x);vec2 o=uv;
 if(uGlassK<1.5){o=.5+c*(1.-uGlass*.55*(1.-r*r*1.6))*(1.-uBass*.08)/vec2(ar,1.);}
 else if(uGlassK<2.5){o=abs(fract(uv*2.)*2.-1.);}
 else if(uGlassK<4.5){float n=uGlassK<3.5?6.:10.;float s=6.2832/n;a=mod(a+uT*.1,s);a=abs(a-s*.5);float rr=uGlassK<3.5?r:r*(1.+.15*sin(a*n*2.+uT));o=.5+vec2(cos(a)/ar,sin(a))*rr;}
 else if(uGlassK<5.5){o=.5-abs(uv-.5);}
 else{vec3 acc=vec3(0.);for(int i=0;i<8;i++){float k=1.-float(i)*.03*uGlass*(1.+uBass);acc+=vec3(S0(.5+(uv-.5)*k).r,S0(.5+(uv-.5)*(k-.01)).g,S0(.5+(uv-.5)*(k-.02)).b);}return mix(S0(uv).rgb,acc/8.*1.3,uGlass);}
 return mix(S0(uv).rgb,S0(fract(o)).rgb,uGlass);}
float shape(vec2 g,float l){vec2 p=g-.5;float r=length(p),a=atan(p.y,p.x);
 if(uDithK<1.5)return step(min(abs(p.x),abs(p.y)),.09+.12*l)*step(max(abs(p.x),abs(p.y)),.1+.4*l);
 if(uDithK<2.5)return step(r,(.12+.33*l)*(.6+.4*cos(a*5.)));
 if(uDithK<3.5)return step(r,(.1+.3*l)*(.7+.3*abs(cos(a*3.))));
 vec2 q=abs(p);return step(max(q.x*.866+q.y*.5,q.y),.08+.4*l);}
void main(){vec2 uv=v;if(uShake>0.)uv+=(vec2(h21(vec2(uT,1.)),h21(vec2(uT,2.)))-.5)*uShake*.06;
 if(uTexK>2.5&&uTexK<3.5&&uTex>0.){vec2 c=uv-.5;uv=.5+c*(1.+dot(c,c)*.25*uTex);}
 vec3 col=uGlass>0.?glass(uv):S0(uv).rgb;
 if(uDith>0.){float cs=max(5.,uRes.y/(28.+uDith*30.));vec2 cell=floor(uv*uRes/cs);vec2 cc=(cell+.5)*cs/uRes;vec3 cc3=uGlass>0.?glass(cc):S0(cc).rgb;float l=dot(cc3,vec3(.3,.59,.11));float m=shape(fract(uv*uRes/cs),l);col=mix(col,cc3*m*1.4+uC1*(1.-m)*.5,uDith);}
 if(uTex>0.){float n=h21(uv*uRes+fract(uT*7.)*91.);
  if(uTexK<1.5)col+=(vec3(n,h21(uv*uRes+3.1+uT),h21(uv*uRes+7.7-uT))-.5)*.5*uTex;
  else if(uTexK<2.5)col*=1.-(n-.5)*.6*uTex;
  else if(uTexK<3.5){float sl=.5+.5*sin(uv.y*uRes.y*3.1416);vec3 mask=vec3(.8+.2*sin(uv.x*uRes.x*2.09),.8+.2*sin(uv.x*uRes.x*2.09+2.09),.8+.2*sin(uv.x*uRes.x*2.09+4.18));col=mix(col,col*mask*(.65+.45*sl)*1.25,uTex);vec2 c=uv-.5;col*=1.-dot(c,c)*1.6*uTex;if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)col=vec3(0.);}
  else{float l=dot(col,vec3(.3,.59,.11));col=mix(col,l>.45-uBass*.15?uC3:uC1,uTex);}}
 if(uInvert>.5)col=1.-col;col=mix(col,vec3(1.),uFlash);col*=1.-uBlack;
 gl_FragColor=vec4(col,1.);}`;
      this.imgSrc = `uniform sampler2D uSrc;uniform float uUse;void main(){vec3 col=texture2D(uSrc,v).rgb;vec3 im=img(v);
 if(uUse<.5)col=max(col,im*(.35+uBass*.9));
 else if(uUse<1.5){vec2 e=vec2(1.5/uRes.x,1.5/uRes.y);float l=dot(im,vec3(.33));float g=abs(l-dot(img(v+vec2(e.x,0.)),vec3(.33)))+abs(l-dot(img(v+vec2(0.,e.y)),vec3(.33)));col+=pal(uT*.1+l)*smoothstep(.04,.25,g)*(1.2+uBass*3.);}
 else{vec2 c=(v-.5)/(1.+uBass*.25)+.5;vec3 i2=img(c);col=col*(.5+.5*dot(i2,vec3(.33)))+i2*uLvl*.8;}
 gl_FragColor=vec4(col,1.);}`;
      this.blitSrc = 'uniform sampler2D uSrc;void main(){gl_FragColor=texture2D(uSrc,v);}';
    }
    tex() { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return t; }
    prog(key, body) {
      if (this.progs[key]) return this.progs[key];
      const gl = this.gl, mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(key + ': ' + gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, HEAD + (body.startsWith('uniform') ? body : 'void main(){' + body + '}'))); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(key + ': ' + gl.getProgramInfoLog(p));
      const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
      return (this.progs[key] = { p, u });
    }
    fbo(w, h, old) {
      const gl = this.gl;
      if (old && old.w === w && old.h === h) return old;
      const t = this.tex(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { f, t, w, h };
    }
    setImage(img) {
      const gl = this.gl; this.hasImg = !!img;
      if (!img) return;
      gl.bindTexture(gl.TEXTURE_2D, this.imgTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }
    upload(A) {
      const gl = this.gl, row = (tex, data) => { const px = new Uint8Array(data.length * 4); for (let i = 0; i < data.length; i++) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = data[i], px[i * 4 + 3] = 255; gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px); };
      row(this.waveTex, A.wave); row(this.specTex, A.spec);
    }
    use(pr, w, h, P, f, t) {
      const gl = this.gl, u = pr.u, C = colorsOf(P).map(rgb);
      gl.useProgram(pr.p); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); const loc = gl.getAttribLocation(pr.p, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const set1 = (n, x) => u[n] && gl.uniform1f(u[n], x);
      gl.uniform2f(u.uRes, w, h); set1('uT', t); set1('uLvl', f.level); set1('uBass', f.bass); set1('uMid', f.mid); set1('uHigh', f.high); set1('uBeat', f.beat);
      set1('uInt', P.intensity); set1('uSize', P.size); set1('uVar', P.variantNow); set1('uHasImg', this.hasImg ? 1 : 0);
      if (u.uC1) { gl.uniform3fv(u.uC1, C[0]); gl.uniform3fv(u.uC2, C[1]); gl.uniform3fv(u.uC3, C[2]); }
      const bind = (n, tex, unit) => { if (!u[n]) return; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[n], unit); };
      bind('uWave', this.waveTex, 1); bind('uSpec', this.specTex, 2); bind('uImg', this.imgTex, 3);
      return { set1, bind };
    }
    /** tiles: [{ P (settings), st (state) }]; grid: [cols, rows]; perf: { flash, shake, invert, black } */
    render(A, tiles, grid, perf, dt) {
      const gl = this.gl, W = this.cv.width, H = this.cv.height, [gc, gr] = grid, tw = Math.floor(W / gc), th = Math.floor(H / gr);
      this.upload(A); V._lastSpec = A.spec;
      gl.disable(gl.BLEND);
      tiles.forEach((tile, i) => {
        const P = tile.P, st = tile.st, m = V.modeOf(P.mode), f = A.f;
        st.t = (st.t || 0) + dt * (0.25 + P.speed * 1.8) * (1 + f.level * 0.5); st.beats = A.f.beats;
        P.variantNow = m.variant;
        const fb = (tile.fb = [this.fbo(tw, th, tile.fb && tile.fb[0]), this.fbo(tw, th, tile.fb && tile.fb[1])]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb[0].f); gl.viewport(0, 0, tw, th);
        if (m.kind === 'gl') { const pr = this.prog(m.key, GL[m.key]); this.use(pr, tw, th, P, f, st.t); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
        else {
          const c = (tile.cv = tile.cv || document.createElement('canvas')); if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
          C2[m.key](c.getContext('2d'), tw, th, f, { ...P, variant: m.variant }, st, A);
          gl.bindTexture(gl.TEXTURE_2D, fb[1].t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          const pr = this.prog('blit', this.blitSrc), x = this.use(pr, tw, th, P, f, st.t); x.bind('uSrc', fb[1].t, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        let src = fb[0], dst = fb[1];
        if (this.hasImg && P.imageUse != null && P.imageUse >= 0) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f); const pr = this.prog('img', this.imgSrc), x = this.use(pr, tw, th, P, f, st.t); x.bind('uSrc', src.t, 0); x.set1('uUse', P.imageUse); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); [src, dst] = [dst, src];
        }
        // Effects, then onto the screen in this tile's place.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const col = i % gc, row = Math.floor(i / gc); gl.viewport(col * tw, H - (row + 1) * th, tw, th);
        const pr = this.prog('fx', this.fxSrc), x = this.use(pr, tw, th, P, f, st.t), fx = P.fx || {};
        x.bind('uSrc', src.t, 0);
        x.set1('uGlass', fx.glass && fx.glass[0] ? fx.glass[1] : 0); x.set1('uGlassK', fx.glass ? fx.glass[0] : 0);
        x.set1('uDith', fx.dither && fx.dither[0] ? fx.dither[1] : 0); x.set1('uDithK', fx.dither ? fx.dither[0] : 0);
        x.set1('uTex', fx.texture && fx.texture[0] ? fx.texture[1] : 0); x.set1('uTexK', fx.texture ? fx.texture[0] : 0);
        x.set1('uFlash', perf.flash || 0); x.set1('uShake', perf.shake || 0); x.set1('uInvert', perf.invert ? 1 : 0); x.set1('uBlack', perf.black || 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        tile.rect = [col * tw, row * th, tw, th];
        // For Track: the same picture at 32×18, read back to find the brightest spots.
        if (fx.track && fx.track[0]) {
          this.small = this.fbo(32, 18, this.small); gl.bindFramebuffer(gl.FRAMEBUFFER, this.small.f); gl.viewport(0, 0, 32, 18);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.readPixels(0, 0, 32, 18, gl.RGBA, gl.UNSIGNED_BYTE, this.probe);
          tile.probe = Float32Array.from({ length: 576 }, (_, k) => { const j = 17 - Math.floor(k / 32), i = k % 32, o = (j * 32 + i) * 4; return this.probe[o] * 0.3 + this.probe[o + 1] * 0.59 + this.probe[o + 2] * 0.11; });
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
      });
    }
    /** Bright spots in each tile, for the Track overlay (read from a small copy of the screen). */
    spots(tile) {
      const g = tile.probe, out = []; if (!g) return out;
      const [x, y, w, h] = tile.rect;
      for (let j = 1; j < 17; j++) for (let i = 1; i < 31; i++) { const v = g[j * 32 + i]; if (v > 140 && v >= g[j * 32 + i - 1] && v >= g[j * 32 + i + 1] && v >= g[(j - 1) * 32 + i] && v >= g[(j + 1) * 32 + i]) out.push({ x: x + ((i + 0.5) / 32) * w, y: y + ((j + 0.5) / 18) * h, v }); }
      return out.sort((a, b) => b.v - a.v).slice(0, 6);
    }
  };

  /** Draws Track overlays (boxes that follow the brightest light) on a 2D canvas above the visuals. */
  V.drawTrack = (g, r, tiles, f, t) => {
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    for (const tile of tiles) {
      const fx = tile.P.fx && tile.P.fx.track; if (!fx || !fx[0] || !tile.rect) continue;
      const kind = fx[0], amt = fx[1], C = colorsOf(tile.P), spots = r.spots(tile), sz = Math.min(tile.rect[2], tile.rect[3]) * (0.06 + amt * 0.08);
      g.lineWidth = Math.max(1, sz * 0.04); g.font = `${Math.max(9, sz * 0.22)}px ui-monospace, Menlo, Consolas, monospace`;
      spots.slice(0, 1 + Math.floor(amt * 5)).forEach((s, i) => {
        const b = sz * (0.8 + f.bass * 0.5), x = s.x - b / 2, y = s.y - b / 2;
        g.strokeStyle = kind === 4 ? C[2] : kind === 5 ? '#39ff14' : C[2]; g.fillStyle = g.strokeStyle; g.shadowBlur = kind === 4 ? 14 : 0; g.shadowColor = C[1];
        if (kind === 3) { const k = b * 0.25; [[x, y, 1, 1], [x + b, y, -1, 1], [x, y + b, 1, -1], [x + b, y + b, -1, -1]].forEach(([a, c, dx, dy]) => { g.beginPath(); g.moveTo(a + dx * k, c); g.lineTo(a, c); g.lineTo(a, c + dy * k); g.stroke(); }); }
        else g.strokeRect(x, y, b, b);
        if (kind === 2 || kind === 5) g.fillText(kind === 5 ? `> OBJ_${String(i).padStart(2, '0')} ${(s.v / 255).toFixed(2)}` : `ID ${i + 1}  ${Math.round(s.x)},${Math.round(s.y)}`, x, y - 4);
        if (kind === 2 && i) { const p = spots[i - 1]; g.globalAlpha = 0.4; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(s.x, s.y); g.stroke(); g.globalAlpha = 1; }
      });
      g.shadowBlur = 0;
    }
  };
})();
