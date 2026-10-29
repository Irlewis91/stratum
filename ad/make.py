"""Builds ad/build/ad-run.js: ad/ad.js with the screenshots embedded, ready for STRATUM --js-test.
   python3 ad/make.py [--stills 1,5,9]   (stills: JPEGs of those moments instead of the video)"""
import base64, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
imgs = {k: 'data:image/jpeg;base64,' + base64.b64encode(open(os.path.join(ROOT, 'download-site/public/img', k + '.jpg'), 'rb').read()).decode()
        for k in ['strata', 'pattern', 'session', 'arrange', 'mixedit']}
pre = 'window.AD_IMAGES = ' + json.dumps(imgs) + ';\n'
if '--stills' in sys.argv: pre += 'window.AD_STILLS = [' + sys.argv[sys.argv.index('--stills') + 1] + '];\n'
if '--cta' in sys.argv: pre += 'window.AD_CTA = ' + json.dumps(sys.argv[sys.argv.index('--cta') + 1]) + ';\n'
pre += 'const IO = S.io, E = S.engine;\n' + open(os.path.join(HERE, (sys.argv[sys.argv.index('--beat') + 1] if '--beat' in sys.argv else 'trap') + '.js')).read() + '\n'
if '--save-beat' in sys.argv: pre = 'window.AD_SAVE_BEAT = true;\n' + pre
os.makedirs(os.path.join(HERE, 'build'), exist_ok=True)
open(os.path.join(HERE, 'build', 'ad-run.js'), 'w').write(pre + open(os.path.join(HERE, 'ad.js')).read())
print('wrote ad/build/ad-run.js')
