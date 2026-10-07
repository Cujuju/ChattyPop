// Which attachments show as text, and how much of them: Discord's own rules, read from its web client (October 2026).

/**
 * File endings Discord previews as text: highlight.js's language names and aliases. Endings holding a dot (cmake.in)
 * are left out; Discord's last-segment match can never hit them.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  `
  1c 4d abnf accesslog ada arduino ino armasm arm avrasm actionscript as ass ssa alan ansi i log ln angelscript
  asc apache apacheconf applescript osascript arcade asciidoc adoc aspectj autohotkey autoit awk mawk nawk gawk
  bash sh zsh basic bbcode blade bnf brainfuck bf csharp cs c h cpp hpp cc hh c++ h++ cxx hxx cal cos cls cmake
  coq csp css csv capnproto capnp chaos kaos chapel chpl cisco clojure clj coffeescript coffee cson iced cpc
  crmsh crm pcmk crystal cr cypher d dns zone bind dos bat cmd dart delphi dpr dfm pas pascal freepascal lazarus
  lpr lfm diff patch django jinja dockerfile docker dsconfig dts dust dst dylan ebnf elixir ex elm erlang erl
  extempore xtlang xtm fsharp fs fix fortran f90 f95 gcode nc gams gms gauss gss godot gdscript gherkin gn gni
  go golang gf golo gololang gradle groovy xml html xhtml rss atom xjb xsd xsl plist svg http https haml
  handlebars hbs haskell hs haxe hx hy hylang ini toml inform7 i7 irpf90 json java jsp javascript js jsx jolie
  iol ol julia julia-repl kotlin kt tex leaf lean lasso ls lassoscript less ldif lisp livecodeserver livescript
  lock lua makefile mk mak make markdown md mkdown mkd mathematica mma wl matlab maxima mel mercury mirc mrc
  mizar mojolicious monkey moonscript moon n1ql nsis never nginx nginxconf nim nimrod nix ocl ocaml ml
  objectivec mm objc obj-c obj-c++ objective-c++ glsl openscad scad ruleslanguage oxygene pf php php3 php4 php5
  php6 php7 parser3 perl pl pm plaintext txt text pony pgsql postgres postgresql powershell ps ps1 processing
  prolog properties proto protobuf puppet pp python py gyp profile python-repl pycon k kdb qml r cshtml razor
  razor-cshtml reasonml re redbol rebol red red-system rib rsl graph instances robot rf rpm-specfile rpm spec
  rpm-spec specfile ruby rb gemspec podspec thor irb rust rs sas scss sql p21 step stp scala scheme scilab sci
  shexc shell console smali smalltalk st sml solidity sol stan stanfuncs stata iecst scl structured-text stylus
  styl subunit supercollider sc srt svelte swift tcl tk terraform tf hcl tap thrift tp tsql ttml twig craftcms
  typescript ts tsx unicorn-rails-log vbnet vb vba vbscript vbs vhdl vala verilog v vim vtt axapta x++ x86asm xl
  tao xquery xpath xq yml yaml zephir zep`.split(/\s+/).filter(Boolean),
);

/** Bytes of a text attachment read for its preview; Discord requests `bytes=0-50000`. */
export const TEXT_PREVIEW_BYTES = 50_001;
/** Lines shown while collapsed, and once expanded (Discord's 6 and 100). */
export const TEXT_COLLAPSED_LINES = 6;
export const TEXT_EXPANDED_LINES = 100;

/** A filename's last dot-segment, lower-cased: the whole name when it has no dot (Dockerfile). */
export const textExtension = (filename: string): string => filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();

/** Whether Discord previews the file as text: by its ending alone, whatever its content type. */
export const isTextFile = (filename: string): boolean => TEXT_EXTENSIONS.has(textExtension(filename));
