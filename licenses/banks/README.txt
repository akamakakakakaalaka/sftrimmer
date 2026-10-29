Project128 GS soundbank notices and reproducible source
Combined derivative license: GPL-2.0-only. Original GeneralUser notice retained.

This is a modified GeneralUser GS 2.0.3 BETA bank by S. Christian Collins, with eight actual alternate presets from TimGM6mb by Tim Brechbill. It is not an authentic Roland SC-88Pro soundbank or engine. All original GeneralUser presets are retained, including the 13 GS drum kits and their XG address variants. Eight TimGM6mb presets occupy MSB 64, LSB 0, at their original zero-based GM program numbers. They are separate sampled/programmed instruments, not renamed GeneralUser aliases.

GeneralUser portions retain the included GeneralUser license v2.0 and its sample-origin statement. TimGM6mb excerpts are GPL version 2, with copyright and documented source/license in TimGM6mb-LICENSE.txt; the complete GPL version 2 is included. The bank modifications, assembly instructions and source URLs are provided here. GeneralUser source allows modification and repackaging; the Tim portions retain GPL-2.0-only terms.

The 500 Soundfonts collection is an aggregation, not a blanket license. Only its TimGM6mb.sf2 entry was retrieved using HTTP Range; no other collection bank was included. Every sample's decoded PCM matches the documented upstream MuseScore TimGM6mb, despite container/program-table differences. See PROVENANCE.json for exact pinned GeneralUser source, Tim source archive entry/range, upstream reference, SHA-256 checksums, selected presets and measured conversion trials.

Reproduce with Node.js 24 and installed project dependencies:
  npm ci
  node tools/prepare-bank.mjs
The tool downloads original uncompressed sources to the system temporary directory, outside the deliverable. PROJECT128_BANK_CACHE may override that location. Those source files are the preferred form for editing, available without charge at the exact URLs in PROVENANCE.json. Generate the complete combined editable bank with: node tools/prepare-bank.mjs --source-output=/path/to/Project128-GS-source.sf2 . All modifications are specified by that script. Include this editable source alongside a redistribution, or use the source-delivery provisions of GPL version 2. No source sample rate reduction or MIDI-dependent trimming is applied. Samples outside Vorbis supported rates remain exact PCM inside the SF3. One source Orchestra Hit loop end exceeded its sample data by one frame and is clamped to the available data, as recorded in PROVENANCE.json.

SF3 uses lossy Ogg Vorbis. The release ZIP preserves the resulting SF3 bytes losslessly, but does not restore the source samples. Quality candidates are measured for decoded finite PCM, retained sample rates and loop points, inventory identity, normalized waveform error during full samples and attacks, and loop-seam error change. These measurements are not listening tests or proof of hardware equivalence. Selected quality: Vorbis q8.

GeneralUser author: https://www.schristiancollins.com/generaluser
TimGM6mb documented license: https://metadata.ftp-master.debian.org/changelogs/main/t/timgm6mb-soundfont/unstable_copyright
Archive: https://archive.org/details/500-soundfonts-full-gm-sets
