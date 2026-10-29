"""Create and verify the requested lossless source archive (not an installable IPA)."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output'
EXCLUDED = {'node_modules', '.git', '.superpowers', 'dist', 'output', 'test-results', 'playwright-report', '__pycache__'}


def main():
    OUT.mkdir(exist_ok=True)
    required = ['ios/Project128.xcodeproj/project.pbxproj', 'ios/Project128/WebBundle/index.html',
                'web/public/banks/starter.sf3', 'docs/features-250.json', 'package-lock.json']
    for filename in required:
        assert (ROOT / filename).is_file(), f'Missing release input: {filename}; run npm run build first'
    features = json.loads((ROOT / 'docs/features-250.json').read_text())
    assert len(features) == 250 and sorted(f['id'] for f in features) == list(range(1,251))
    files = [p for p in ROOT.rglob('*') if p.is_file() and not any(x in EXCLUDED for x in p.relative_to(ROOT).parts)
             and not p.name.endswith(('.log', '.sf2', '.xcuserstate')) and not p.is_symlink()
             and p.relative_to(ROOT).as_posix() != 'ios/Project128/WebBundle/banks/starter.sf3']
    archive = OUT / 'Project128_iOS_Source.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(files):
            z.write(path, Path('Project128') / path.relative_to(ROOT))
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for path in files:
            assert z.read(str(Path('Project128')/path.relative_to(ROOT))) == path.read_bytes()
    size = archive.stat().st_size
    assert size < 20_000_000, f'Archive exceeds 20 MB: {size} bytes'
    report = {'artifact': archive.name, 'kind': 'Source and bundled web runtime; not a signed IPA',
              'bytes': size, 'under_20MB': True, 'files': len(files), 'features_catalog_count': 250,
              'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'CRC_and_file_bytes_verified': True}
    (OUT/'package-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
