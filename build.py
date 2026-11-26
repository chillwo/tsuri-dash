import re, json
import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
S='src/'
css=open(S+'style.css').read()
# light-dark() を古いブラウザでも動く CSS 変数 + prefers-color-scheme に変換
out=''; i=0; n=0; lights=[]; darks=[]
while True:
    k=css.find('light-dark(',i)
    if k<0: out+=css[i:]; break
    out+=css[i:k]; j=k+len('light-dark('); depth=1; start=j; comma=None
    while depth:
        c=css[j]
        if c=='(': depth+=1
        elif c==')': depth-=1
        elif c==',' and depth==1 and comma is None: comma=j
        j+=1
    a=css[start:comma].strip(); b=css[comma+1:j-1].strip()
    out+=f'var(--ld{n})'; lights.append(f'--ld{n}:{a}'); darks.append(f'--ld{n}:{b}'); n+=1; i=j
out=re.sub(r':root\[data-theme=light\]\{[^}]*\}\n?','',out)
out=re.sub(r':root\[data-theme=dark\]\{[^}]*\}\n?','',out)
out+='\n:root{'+';'.join(lights)+'}\n@media(prefers-color-scheme:dark){:root{'+';'.join(darks)+'}}\n'
out+='.filebtn{display:inline-flex;align-items:center;cursor:pointer}\n'
assert 'light-dark' not in out
js='{\n\'use strict\';\n'+open(S+'astro.js').read()+'\n'+open(S+'backend.js').read()+'\n'
app=open(S+'app.js').read()
assert app.startswith("{\n'use strict';")
js+=app[len("{\n'use strict';"):]
html=open(S+'index.html').read().replace('/*CSS*/',out).replace('/*JS*/',js.replace('</script','<\\/script'))
open('index.html','w').write(html)
json.dump({"name":"釣り情報ダッシュボード","short_name":"釣りダッシュ","start_url":"./","display":"standalone","background_color":"#0d4a57","theme_color":"#0d4a57","lang":"ja","icons":[{"src":"icon-192.png","sizes":"192x192","type":"image/png"},{"src":"icon-512.png","sizes":"512x512","type":"image/png"}]},open('manifest.webmanifest','w'),ensure_ascii=False,indent=1)
print('built',len(html))
