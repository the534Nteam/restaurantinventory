#!/bin/sh
# Builds pl-inventory-artifact.html, the claude.ai artifact copy of index.html.
# The artifact runs offline (no Firebase scripts), saves files through the
# downloads capability, and copies email text instead of opening mailto links.
set -e
cd "$(dirname "$0")"
python3 - <<'EOF'
import re
src = open('index.html', encoding='utf-8').read()
src = re.sub(r'<script src="https://www\.gstatic\.com/firebasejs/[^"]+"></script>\n', '', src)
src = src.replace('const IN_ARTIFACT=false;', 'const IN_ARTIFACT=true;', 1)
start = src.index('<title>')
src = src[start:]
src = src.replace('</head>\n<body>\n', '', 1)
src = src.replace('</body>\n</html>\n', '</body></html>', 1)
open('pl-inventory-artifact.html', 'w', encoding='utf-8').write(src)
EOF
echo "Wrote pl-inventory-artifact.html"
