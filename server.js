const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
function normalizeUserMap(db){
  const out={};
  for(const [oldKey, raw] of Object.entries(db && db.users && typeof db.users==='object' ? db.users : {})){
    if(!raw || typeof raw!=='object') continue;
    const u={...raw};
    const displayName=String(u.name || u.profile?.name || oldKey || '').trim().normalize('NFKC');
    if(!displayName) continue;
    u.name=displayName;
    u.profile=(u.profile && typeof u.profile==='object') ? {...u.profile,name:displayName} : {name:displayName,trophies:0,wins:0,losses:0,best:0,history:[],unlocked:['spider']};
    const key=displayName.toLocaleLowerCase('ko-KR');
    // If case/normalization variants exist, keep the record with more profile progress.
    const score=x=>Number(x?.profile?.trophies||0)+Number(x?.profile?.wins||0)*2+Number(x?.profile?.best||0);
    if(!out[key] || score(u)>score(out[key])) out[key]=u;
  }
  return {users:out};
}
function loadAccounts(){
  // Check both the configured persistent disk and older app-directory locations.
  const candidates=[...new Set([DB_FILE,DB_FILE+'.bak',path.join(ROOT,'data','accounts.json'),path.join(ROOT,'data','accounts.json.bak'),path.join(ROOT,'accounts.json'),'/data/accounts.json','/data/accounts.json.bak'])];
  const valid=[];
  for(const candidate of candidates){
    try{
      const raw=JSON.parse(fs.readFileSync(candidate,'utf8'));
      if(raw && raw.users && typeof raw.users==='object'){
        const normalized=normalizeUserMap(raw);
        valid.push({candidate,value:normalized,count:Object.keys(normalized.users).length,bytes:fs.statSync(candidate).size});
      }
    }catch{}
  }
  // Never prefer an empty freshly-created DB over a backup containing accounts.
  valid.sort((a,b)=>b.count-a.count || b.bytes-a.bytes);
  const found=valid.find(x=>x.count>0)||valid[0];
  if(found){
    if(found.candidate!==DB_FILE){
      try{
        if(fs.existsSync(DB_FILE) && !fs.existsSync(DB_FILE+'.bak')) fs.copyFileSync(DB_FILE,DB_FILE+'.bak');
        const tmp=DB_FILE+'.migrate.tmp';
        fs.writeFileSync(tmp,JSON.stringify(found.value),{mode:0o600});
        fs.renameSync(tmp,DB_FILE);
        console.log(`계정 DB 이전 완료: ${found.candidate} -> ${DB_FILE} (${found.count}개 계정)`);
      }catch(e){console.error('계정 DB 이전 실패:',e.message);}
    }
    console.log(`계정 DB 확인: ${found.candidate} (${found.count}개 계정)`);
    return found.value;
  }
  console.error(`계정 DB를 찾지 못했습니다. 새 계정 DB를 만들기 전에 DATA_DIR 및 Render Persistent Disk를 확인하세요. 대상 경로: ${DB_FILE}`);
  return {users:{}};
}
let accountDB=loadAccounts();
function saveAccounts(){
  const tmp=DB_FILE+'.tmp';
  // Keep the previous database as a backup before replacing it.
  if(fs.existsSync(DB_FILE)){
    try{fs.copyFileSync(DB_FILE,DB_FILE+'.bak');}catch(e){console.error('계정 DB 백업 실패:',e.message);throw e;}
  }
  fs.writeFileSync(tmp,JSON.stringify(accountDB),{mode:0o600});
  fs.renameSync(tmp,DB_FILE);
}
const sessions = new Map();
function publicProfile(u){ const p=u.profile||{}; return {name:u.name,trophies:Number(p.trophies)||0,wins:Number(p.wins)||0,losses:Number(p.losses)||0,best:Number(p.best)||0,history:Array.isArray(p.history)?p.history.slice(0,12):[],unlocked:Array.isArray(p.unlocked)?p.unlocked:['spider']}; }
function hashPassword(password,salt){ return crypto.scryptSync(password,salt,64).toString('hex'); }
function readBody(req){ return new Promise((resolve,reject)=>{let s='',size=0;req.on('data',c=>{size+=c.length;if(size>100000){reject(new Error('요청이 너무 큽니다.'));req.destroy();return;}s+=c;});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'));}catch{reject(new Error('요청 형식이 올바르지 않습니다.'));}});req.on('error',reject);}); }
function sendJSON(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function cleanProfile(p, name){ p=p&&typeof p==='object'?p:{}; return {name,trophies:Math.max(0,Math.min(1000000,Math.floor(Number(p.trophies)||0))),wins:Math.max(0,Math.floor(Number(p.wins)||0)),losses:Math.max(0,Math.floor(Number(p.losses)||0)),best:Math.max(0,Math.floor(Number(p.best)||0),Math.floor(Number(p.trophies)||0)),history:Array.isArray(p.history)?p.history.slice(0,12).map(h=>({win:!!h.win,fighter:String(h.fighter||'전사').slice(0,30),at:String(h.at||'').slice(0,30)})):[],unlocked:Array.isArray(p.unlocked)?[...new Set(['spider',...p.unlocked.filter(x=>['spider','hammer','vampire','poojizik','meto'].includes(x))])]:['spider']}; }
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if(pathname.startsWith('/api/')){
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'});return res.end();}
    if(pathname==='/api/leaderboard' && req.method==='GET'){
      const users=Object.values(accountDB.users).map(u=>({name:u.name,trophies:Number(u.profile?.trophies)||0,wins:Number(u.profile?.wins)||0})).sort((a,b)=>b.trophies-a.trophies||b.wins-a.wins||a.name.localeCompare(b.name,'ko')).slice(0,100);
      return sendJSON(res,200,{users});
    }
    if(req.method!=='POST') return sendJSON(res,405,{error:'지원하지 않는 요청입니다.'});
    try{
      const body=await readBody(req);
      if(pathname==='/api/signup' || pathname==='/api/login'){
        const name=String(body.name||'').trim().normalize('NFKC'); const key=name.toLocaleLowerCase('ko-KR'); const password=String(body.password||'');
        if(name.length<2||name.length>16||/[\\/<>\u0000-\u001f]/.test(name)) return sendJSON(res,400,{error:'이름은 2~16자로 입력해 주세요.'});
        if(password.length<4||password.length>128) return sendJSON(res,400,{error:'비밀번호는 4~128자로 입력해 주세요.'});
        if(pathname==='/api/signup'){
          if(accountDB.users[key]) return sendJSON(res,409,{error:'이미 사용 중인 이름입니다. 다른 이름을 사용해 주세요.'});
          const salt=crypto.randomBytes(16).toString('hex');
          const profile={name,trophies:0,wins:0,losses:0,best:0,history:[],unlocked:['spider']};
          accountDB.users[key]={name,salt,passwordHash:hashPassword(password,salt),profile}; saveAccounts();
        } else {
          const u=accountDB.users[key];
          if(!u) return sendJSON(res,401,{error:'계정을 찾을 수 없습니다. 기존 계정 데이터가 연결된 디스크에 있는지 확인해 주세요.'});
          let valid=false;
          if(typeof u.salt==='string' && typeof u.passwordHash==='string'){
            try{valid=crypto.timingSafeEqual(Buffer.from(hashPassword(password,u.salt),'hex'),Buffer.from(u.passwordHash,'hex'));}catch{valid=false;}
          } else if(typeof u.password==='string') {
            // Older versions stored password directly. Verify it once, then migrate to a salted hash.
            valid=(u.password===password);
            if(valid){const salt=crypto.randomBytes(16).toString('hex');u.salt=salt;u.passwordHash=hashPassword(password,salt);delete u.password;saveAccounts();}
          }
          if(!valid) return sendJSON(res,401,{error:'이름 또는 비밀번호가 올바르지 않습니다.'});
        }
        const u=accountDB.users[key]; const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,key);
        return sendJSON(res,200,{token,profile:publicProfile(u)});
      }
      if(pathname==='/api/profile'){
        const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''); const key=sessions.get(token); if(!key||!accountDB.users[key])return sendJSON(res,401,{error:'로그인이 만료되었습니다. 다시 로그인해 주세요.'});
        accountDB.users[key].profile=cleanProfile(body.profile,accountDB.users[key].name); saveAccounts(); return sendJSON(res,200,{profile:publicProfile(accountDB.users[key])});
      }
      return sendJSON(res,404,{error:'API를 찾을 수 없습니다.'});
    }catch(e){return sendJSON(res,400,{error:e.message||'요청을 처리하지 못했습니다.'});}
  }
  const file = pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(file); res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res);
});
const wss = new WebSocket.Server({ server });
let waiting = null; let nextRoom = 1; const rooms = new Map();
function send(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(room, from, data) { for (const p of room.players) if (p !== from) send(p, data); }
wss.on('connection', ws => {
  ws.alive = true; ws.room = null; ws.on('pong', () => ws.alive = true);
  ws.on('message', raw => { let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join') { if (ws.room) return; ws.name = String(msg.name || '플레이어').slice(0, 16); ws.fighter = ['spider','hammer','vampire','poojizik','meto'].includes(msg.fighter) ? msg.fighter : 'spider'; ws.fighterHp = Number(msg.hp) || (ws.fighter === 'hammer' ? 105 : ws.fighter === 'vampire' ? 90 : ws.fighter === 'poojizik' ? 95 : ws.fighter === 'meto' ? 80 : 100);
      if (waiting && waiting.readyState === WebSocket.OPEN && waiting !== ws) { const a = waiting; waiting = null; const room = { id: String(nextRoom++), players: [a, ws] }; rooms.set(room.id, room); a.room = ws.room = room; send(a, { type: 'matched', slot: 0, opponent: ws.name, fighter: ws.fighter, hp: ws.fighterHp, room: room.id }); send(ws, { type: 'matched', slot: 1, opponent: a.name, fighter: a.fighter, hp: a.fighterHp, room: room.id }); }
      else { waiting = ws; send(ws, { type: 'waiting', message: '상대를 찾는 중입니다…' }); }
    } else if (msg.type === 'cancel') { if (waiting === ws) waiting = null; send(ws, { type: 'cancelled' }); }
    else if (ws.room && ['state', 'damage', 'heal', 'attack', 'pull', 'pooDamage', 'result', 'ready'].includes(msg.type)) broadcast(ws.room, ws, { ...msg, sender: ws.name });
  });
  ws.on('close', () => { if (waiting === ws) waiting = null; if (ws.room) { const room = ws.room; rooms.delete(room.id); broadcast(room, ws, { type: 'opponent_left' }); for (const p of room.players) { p.room = null; if (p !== ws) send(p, { type: 'opponent_left' }); } } });
});
const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 30000);
server.listen(PORT, '0.0.0.0', () => { console.log(`원격돌격 서버 실행: ${PORT}; 계정 DB: ${DB_FILE}`); if (DATA_DIR !== '/data' && process.env.NODE_ENV === 'production') console.warn('주의: Render Persistent Disk를 /data에 연결해야 계정과 랭킹이 재배포 후에도 유지됩니다.'); });
process.on('SIGTERM', () => { clearInterval(heartbeat); server.close(() => process.exit(0)); });
