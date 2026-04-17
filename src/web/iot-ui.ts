/**
 * 物联网 3D 数字孪生平台 — Three.js 精致办公空间可视化
 * 功能：真实渲染风格 + 交互式房间布局 + AI 设备推荐 + 数据孪生
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export function serveIotPage(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildIotHtml());
}

function buildIotHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>数字孪生平台</title>
<link rel="shortcut icon" type="image/x-icon" href="">
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#061210;--panel:rgba(8,22,18,0.88);--soft:rgba(16,40,32,0.6);
  --tx:#E8F5F0;--tx2:#8EBFAD;--tx3:#5A8A78;
  --accent:#2DD4A8;--accent2:#5EEBC0;--green:#3DD68C;--red:#EF4444;--orange:#F59E0B;
  --border:rgba(45,212,168,0.2);--radius:12px;
  --font:system-ui,-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif;
}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--tx);overflow:hidden}
.app{position:relative;height:100vh;width:100vw}

/* ── Header (glass) ── */
.header{
  position:fixed;top:0;left:0;right:0;height:56px;z-index:100;
  display:flex;align-items:center;padding:0 24px;gap:20px;
  background:linear-gradient(180deg,rgba(6,18,16,0.95) 0%,rgba(6,18,16,0.6) 100%);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
}
.header-brand{display:flex;align-items:center;gap:12px}
.header-brand svg{width:32px;height:32px;filter:drop-shadow(0 0 8px rgba(45,212,168,.6))}
.header-brand h1{font-size:15px;font-weight:700;letter-spacing:.5px;background:linear-gradient(135deg,#E8F5F0,#5EEBC0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header-brand span{font-size:10px;color:var(--tx3);text-transform:uppercase;letter-spacing:1.5px;display:block;margin-top:2px}
.header-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:22px;font-weight:800;letter-spacing:1px;text-align:center}
.header-center .sub{font-size:9px;color:var(--tx3);letter-spacing:3px;font-weight:500;margin-bottom:2px}
.header-status{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:12px;color:var(--tx2)}
.header-status .dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);animation:pulse 2s infinite}
.header-status .clock{font-variant-numeric:tabular-nums;color:var(--tx)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(0.85)}}

/* ── Left Panel (floating glass card) ── */
.panel-left{
  position:fixed;top:72px;left:16px;bottom:16px;width:340px;z-index:50;
  background:var(--panel);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid var(--border);border-radius:16px;
  box-shadow:0 8px 40px rgba(0,0,0,.4);
  display:flex;flex-direction:column;overflow:hidden;
}
.panel-section{padding:16px 18px;border-bottom:1px solid var(--border)}
.panel-section h2{font-size:11px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:6px}
.panel-scroll{flex:1;overflow-y:auto;padding:0 0 8px}

/* ── Form Controls ── */
.form-group{margin-bottom:14px}
.form-label{display:block;font-size:10px;font-weight:600;color:var(--tx2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.8px}
.form-input{
  width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--border);
  background:var(--soft);color:var(--tx);font-size:13px;outline:none;transition:all .15s;
}
.form-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(45,212,168,.15)}
select.form-input{cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%23A3ADD0' fill='none' stroke-width='1.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}

/* ── Buttons ── */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  padding:9px 16px;border-radius:10px;font-size:12px;font-weight:600;
  border:none;cursor:pointer;transition:all .15s;font-family:inherit;
}
.btn-primary{background:linear-gradient(135deg,#2DD4A8,#5EEBC0);color:#0A1A14;font-weight:700;box-shadow:0 4px 16px rgba(45,212,168,.3)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(45,212,168,.45)}
.btn-primary:active{transform:translateY(0)}
.btn-success{background:var(--green);color:#000}
.btn-danger{background:var(--red);color:#fff}
.btn-ghost{background:var(--soft);color:var(--tx2);border:1px solid var(--border)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent);background:rgba(45,212,168,.08)}
.btn-block{width:100%}
.btn-group{display:flex;gap:8px}

/* ── Room Cards ── */
.room-card{
  padding:12px 14px;margin:6px 14px;border-radius:10px;
  background:var(--soft);border:1px solid var(--border);cursor:pointer;
  transition:all .2s;position:relative;
}
.room-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);border-radius:10px 0 0 10px;opacity:0;transition:opacity .15s}
.room-card:hover{border-color:var(--accent);transform:translateX(2px)}
.room-card.active{border-color:var(--accent);background:linear-gradient(90deg,rgba(45,212,168,.15),rgba(45,212,168,.03))}
.room-card.active::before{opacity:1}
.room-card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.room-card-header h3{font-size:13px;font-weight:600}
.room-card-header .badge{font-size:10px;padding:2px 8px;border-radius:99px;background:rgba(45,212,168,.15);color:var(--accent2);font-weight:600}
.room-card-meta{display:flex;gap:12px;font-size:11px;color:var(--tx2)}
.room-card-products{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
.room-card-products .tag{font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(45,212,168,.08);color:var(--accent2)}

/* ── Viewport overlay ── */
.viewport-overlay-bottom{
  position:fixed;bottom:24px;left:380px;right:360px;z-index:40;
  display:flex;gap:10px;pointer-events:none;justify-content:center;
}
.viewport-pill{
  pointer-events:auto;padding:8px 16px;border-radius:99px;
  background:rgba(8,22,18,0.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border:1px solid var(--border);font-size:11px;color:var(--tx2);
  display:flex;align-items:center;gap:8px;
}
.viewport-pill .val{color:var(--tx);font-weight:700}
.viewport-pill.hint{color:var(--tx3);font-size:10px}

/* Zoom control */
.zoom-ctrl{
  position:fixed;bottom:24px;left:380px;z-index:40;
  display:flex;align-items:center;gap:10px;padding:6px 14px;
  background:rgba(8,22,18,0.88);backdrop-filter:blur(12px);
  border:1px solid var(--border);border-radius:99px;
}
.zoom-ctrl button{width:28px;height:28px;border-radius:50%;border:none;background:var(--soft);color:var(--tx);cursor:pointer;font-size:14px}
.zoom-ctrl button:hover{background:var(--accent);color:#fff}

/* ── Right Panel ── */
.panel-right{
  position:fixed;top:72px;right:16px;bottom:16px;width:340px;z-index:50;
  background:var(--panel);backdrop-filter:blur(20px);
  border:1px solid var(--border);border-radius:16px;
  box-shadow:0 8px 40px rgba(0,0,0,.4);
  display:flex;flex-direction:column;overflow:hidden;
}
.product-list{flex:1;overflow-y:auto;padding:8px}
.product-item{
  display:flex;align-items:flex-start;gap:12px;padding:12px;
  border-radius:10px;margin-bottom:6px;transition:all .15s;
  border:1px solid transparent;
}
.product-item:hover{background:var(--soft);border-color:var(--border)}
.product-icon{font-size:24px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:var(--soft);border-radius:10px;flex-shrink:0;border:1px solid var(--border)}
.product-info{flex:1;min-width:0}
.product-name{font-size:13px;font-weight:600;margin-bottom:3px;display:flex;align-items:center;gap:6px}
.product-detail{font-size:11px;color:var(--tx2);line-height:1.5}
.product-qty{font-size:13px;font-weight:700;color:var(--accent2);white-space:nowrap}
.product-iot{display:inline-block;font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(61,214,140,.15);color:var(--green);font-weight:600;letter-spacing:.5px}

.summary-bar{padding:14px 18px;border-top:1px solid var(--border);background:var(--soft)}
.summary-row{display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px}
.summary-row .label{color:var(--tx2)}
.summary-row .value{font-weight:700;color:var(--tx)}
.summary-total{font-size:14px;font-weight:700;color:var(--green);margin-top:8px;padding-top:8px;border-top:1px solid var(--border);display:flex;justify-content:space-between}

/* Upload area */
.upload-area{
  border:2px dashed var(--border);border-radius:10px;padding:20px;
  text-align:center;cursor:pointer;transition:all .2s;
  background:rgba(45,212,168,.03);
}
.upload-area:hover{border-color:var(--accent);background:rgba(45,212,168,.06)}
.upload-area input{display:none}
.upload-area .upload-icon{font-size:28px;margin-bottom:6px;opacity:.6}
.upload-area p{font-size:11px;color:var(--tx2)}
.upload-preview{max-width:100%;border-radius:8px;margin-top:8px;max-height:120px;object-fit:cover}

/* Scroll */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--accent)}

/* Toast */
.toast{
  position:fixed;top:72px;left:50%;z-index:999;padding:12px 24px;
  border-radius:10px;font-size:13px;font-weight:500;
  background:rgba(15,20,35,0.95);backdrop-filter:blur(12px);
  border:1px solid var(--accent);color:var(--tx);
  transform:translate(-50%,-20px);opacity:0;pointer-events:none;
  transition:all .3s ease;
  box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:500px;text-align:center;
}
.toast.show{transform:translate(-50%,0);opacity:1;pointer-events:auto}

/* Room Detail Modal */
.room-modal{
  position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);
  display:none;align-items:center;justify-content:center;padding:20px;
}
.room-modal.show{display:flex}
.room-modal-content{
  width:min(720px,96vw);max-height:86vh;overflow:hidden;
  background:linear-gradient(180deg,rgba(10,26,20,.98),rgba(6,18,16,.98));
  border:1px solid var(--border);border-radius:18px;
  display:flex;flex-direction:column;
  box-shadow:0 20px 60px rgba(0,0,0,.5);
}
.room-modal-header{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start}
.room-modal-header h2{font-size:20px;font-weight:700;margin-bottom:4px}
.room-modal-header .sub{font-size:12px;color:var(--tx3)}
.room-modal-close{width:32px;height:32px;border-radius:50%;background:var(--soft);border:none;color:var(--tx2);font-size:20px;cursor:pointer}
.room-modal-close:hover{background:var(--red);color:#fff}
.room-modal-body{padding:20px 24px;overflow-y:auto;flex:1}
.room-stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
.room-stat{padding:12px;border-radius:10px;background:var(--soft);border:1px solid var(--border);text-align:center}
.room-stat-val{font-size:20px;font-weight:700;color:var(--accent2);line-height:1}
.room-stat-label{font-size:10px;color:var(--tx3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
.sensor-live{display:flex;align-items:center;gap:6px;padding:8px 12px;background:rgba(61,214,140,.08);border:1px solid rgba(61,214,140,.2);border-radius:8px;font-size:12px}
.sensor-live .pulse{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite;box-shadow:0 0 6px var(--green)}

/* Right panel state: no selection */
.empty-state{padding:40px 20px;text-align:center;color:var(--tx3)}
.empty-state .icon{font-size:48px;margin-bottom:12px;opacity:.4}

/* Section divider with label */
.section-label{padding:16px 20px 8px;font-size:11px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:1px}

/* ── AI Chat Panel ── */
.ai-chat-toggle{
  position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:90;
  display:flex;align-items:center;gap:8px;
  padding:10px 20px;border-radius:24px;border:1px solid var(--border);
  background:var(--panel);backdrop-filter:blur(20px);
  color:var(--tx);font-size:13px;font-weight:600;cursor:pointer;
  box-shadow:0 8px 32px rgba(0,0,0,.4);transition:all .2s;
}
.ai-chat-toggle:hover{border-color:var(--accent);box-shadow:0 8px 32px rgba(45,212,168,.2)}
.ai-chat-panel{
  position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:200;
  width:min(640px,90vw);max-height:460px;
  background:var(--panel);backdrop-filter:blur(24px);
  border:1px solid var(--border);border-radius:18px;
  box-shadow:0 16px 64px rgba(0,0,0,.5);
  display:none;flex-direction:column;overflow:hidden;
}
.ai-chat-panel.open{display:flex}
.ai-chat-header{
  padding:14px 18px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
}
.ai-chat-header h3{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px}
.ai-chat-header h3 .badge{font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(45,212,168,.15);color:var(--accent);font-weight:600}
.ai-chat-close{width:28px;height:28px;border-radius:50%;border:none;background:var(--soft);color:var(--tx2);cursor:pointer;font-size:16px}
.ai-chat-close:hover{background:var(--red);color:#fff}
.ai-chat-messages{flex:1;overflow-y:auto;padding:14px 18px;min-height:120px;max-height:300px}
.ai-msg{margin-bottom:12px;display:flex;gap:10px;align-items:flex-start}
.ai-msg.user{flex-direction:row-reverse}
.ai-msg-avatar{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.ai-msg.assistant .ai-msg-avatar{background:linear-gradient(135deg,#2DD4A8,#5EEBC0);color:#0A1A14}
.ai-msg.user .ai-msg-avatar{background:var(--soft);border:1px solid var(--border)}
.ai-msg-bubble{max-width:85%;padding:10px 14px;border-radius:12px;font-size:12.5px;line-height:1.7}
.ai-msg.assistant .ai-msg-bubble{background:var(--soft);border:1px solid var(--border);color:var(--tx)}
.ai-msg.user .ai-msg-bubble{background:linear-gradient(135deg,rgba(45,212,168,.15),rgba(94,235,192,.08));border:1px solid rgba(45,212,168,.3);color:var(--tx)}
.ai-msg-thinking{display:flex;gap:4px;padding:8px 0}
.ai-msg-thinking span{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:think 1.4s infinite}
.ai-msg-thinking span:nth-child(2){animation-delay:.2s}
.ai-msg-thinking span:nth-child(3){animation-delay:.4s}
@keyframes think{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
.ai-chat-input-bar{padding:12px 14px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center}
.ai-chat-input{flex:1;background:var(--soft);border:1px solid var(--border);border-radius:10px;padding:10px 14px;color:var(--tx);font-size:13px;outline:none;resize:none;font-family:var(--font);min-height:40px;max-height:80px}
.ai-chat-input::placeholder{color:var(--tx3)}
.ai-chat-input:focus{border-color:var(--accent)}
.ai-chat-send{width:36px;height:36px;border-radius:50%;border:none;background:linear-gradient(135deg,#2DD4A8,#5EEBC0);color:#0A1A14;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .2s}
.ai-chat-send:hover{transform:scale(1.05);box-shadow:0 0 16px rgba(45,212,168,.4)}
.ai-chat-send:disabled{opacity:.4;cursor:not-allowed;transform:none}
.ai-chat-hints{padding:8px 18px 12px;display:flex;gap:6px;flex-wrap:wrap}
.ai-chat-hint{padding:5px 10px;border-radius:8px;border:1px solid var(--border);background:var(--soft);color:var(--tx2);font-size:11px;cursor:pointer;transition:all .15s}
.ai-chat-hint:hover{border-color:var(--accent);color:var(--accent);background:rgba(45,212,168,.08)}

/* Responsive */
@media(max-width:1280px){.panel-right{width:300px}.viewport-overlay-bottom{right:320px}.zoom-ctrl{left:360px}.panel-left{width:320px}.viewport-overlay-bottom{left:360px}}
@media(max-width:900px){.panel-left{width:280px}.panel-right{display:none}.viewport-overlay-bottom{right:20px}.ai-chat-panel{width:calc(100vw - 32px)}}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-brand">
    <img id="brandLogo" style="width:32px;height:32px;border-radius:50%;object-fit:contain;display:none" alt="">
    <svg id="brandSvg" viewBox="0 0 32 32" fill="none"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2DD4A8"/><stop offset="1" stop-color="#5EEBC0"/></linearGradient></defs><circle cx="16" cy="16" r="13" stroke="url(#lg)" stroke-width="2"/><circle cx="16" cy="16" r="4" fill="url(#lg)"/><line x1="16" y1="3" x2="16" y2="9" stroke="url(#lg)" stroke-width="1.8" stroke-linecap="round"/><line x1="16" y1="23" x2="16" y2="29" stroke="url(#lg)" stroke-width="1.8" stroke-linecap="round"/><line x1="3" y1="16" x2="9" y2="16" stroke="url(#lg)" stroke-width="1.8" stroke-linecap="round"/><line x1="23" y1="16" x2="29" y2="16" stroke="url(#lg)" stroke-width="1.8" stroke-linecap="round"/></svg>
    <div>
      <h1 id="brandName">数字孪生平台</h1>
      <span>OFFICE DIGITAL TWIN</span>
    </div>
  </div>
  <div class="header-center">
    <div class="sub">OPC DIGITAL TWIN PLATFORM</div>
    <div id="headerTitle">数字孪生平台</div>
  </div>
  <div class="header-status">
    <div style="display:flex;align-items:center;gap:6px"><div class="dot"></div>WebSocket 实时推送</div>
    <div class="clock" id="clockDisplay"></div>
  </div>
</div>

<!-- 3D Viewport (full-screen) -->
<canvas id="canvas3d" style="position:fixed;top:0;left:0;width:100%;height:100%;display:block;z-index:1"></canvas>

<!-- Left Panel -->
<div class="panel-left">
  <div class="panel-section">
    <h2>🏛️ 空间配置</h2>
    <div class="form-group">
      <label class="form-label">空间名称</label>
      <input class="form-input" id="spaceName" value="我的办公空间" placeholder="输入空间名称" oninput="updateHeaderTitle()">
    </div>
    <div class="form-group">
      <label class="form-label">总面积 (㎡)</label>
      <input class="form-input" id="totalArea" type="number" value="200" min="20" max="10000">
    </div>
    <div class="form-group">
      <label class="form-label">上传平面图 / 照片（可选）</label>
      <div class="upload-area" onclick="document.getElementById('photoInput').click()">
        <input type="file" id="photoInput" accept="image/*" onchange="handlePhotoUpload(this)">
        <div class="upload-icon">📷</div>
        <p>点击上传户型图或参考照片</p>
        <img id="photoPreview" class="upload-preview" style="display:none">
      </div>
    </div>
    <button class="btn btn-primary btn-block" onclick="generateLayout()">🚀 自动生成 3D 布局</button>
  </div>

  <div class="panel-section" style="padding-bottom:10px">
    <h2>🏠 房间列表 <span style="font-size:10px;color:var(--tx3);font-weight:400;margin-left:auto" id="roomCount">0 间</span></h2>
    <div class="btn-group">
      <button class="btn btn-ghost" style="flex:1" onclick="showAddRoom()">+ 添加</button>
      <button class="btn btn-ghost" onclick="exportDeviceList()" title="导出设备清单">📋</button>
      <button class="btn btn-ghost" onclick="toggleViewMode()" id="view-mode-btn" title="切换视图">🎥</button>
    </div>
  </div>
  <div class="panel-scroll" id="roomList"></div>
</div>

<!-- Right Panel -->
<div class="panel-right">
  <div class="panel-section">
    <h2>📦 设备推荐清单</h2>
    <p style="font-size:11px;color:var(--tx3)" id="roomHint">点击房间查看推荐</p>
  </div>
  <div class="product-list" id="productList">
    <div class="empty-state">
      <div class="icon">📡</div>
      <p style="font-size:12px">生成布局后查看每个房间的设备推荐</p>
    </div>
  </div>
  <div class="summary-bar" id="summaryBar" style="display:none">
    <div class="summary-row"><span class="label">🪑 家具设备</span><span class="value" id="sumFurniture">0</span></div>
    <div class="summary-row"><span class="label">📡 IoT 传感器</span><span class="value" id="sumSensors">0</span></div>
    <div class="summary-row"><span class="label">🌐 网络设备</span><span class="value" id="sumNetwork">0</span></div>
    <div class="summary-total"><span>共计</span><span><span id="sumTotal">0</span> 件</span></div>
    <button class="btn-primary" style="width:100%;margin-top:8px;padding:8px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#2DD4A8,#5EEBC0);color:#0A1A14" onclick="exportDeviceList()">📋 导出设备清单</button>
  </div>
</div>

<!-- Bottom HUD -->
<div class="zoom-ctrl">
  <button onclick="cameraZoom(-1)">−</button>
  <span style="font-size:11px;color:var(--tx2)">缩放 <span id="zoomVal">100%</span></span>
  <button onclick="cameraZoom(1)">+</button>
</div>
<div class="viewport-overlay-bottom">
  <div class="viewport-pill">📐 面积 <span class="val" id="vpArea">200</span> ㎡</div>
  <div class="viewport-pill">🏠 房间 <span class="val" id="vpRooms">0</span> 间</div>
  <div class="viewport-pill">📡 设备 <span class="val" id="vpDevices">0</span> 台</div>
  <div class="viewport-pill hint">🖱️ 左键旋转 · 右键平移 · 滚轮缩放</div>
</div>

<!-- Room Detail Modal -->
<div class="room-modal" id="roomModal">
  <div class="room-modal-content">
    <div class="room-modal-header">
      <div>
        <h2 id="rmName">房间</h2>
        <div class="sub" id="rmSub"></div>
      </div>
      <button class="room-modal-close" onclick="closeRoomModal()">×</button>
    </div>
    <div class="room-modal-body" id="rmBody"></div>
  </div>
</div>

<!-- AI Chat Toggle Button -->
<button class="ai-chat-toggle" id="aiChatToggle" onclick="toggleAiChat()">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  AI 布局助手
</button>

<!-- AI Chat Panel -->
<div class="ai-chat-panel" id="aiChatPanel">
  <div class="ai-chat-header">
    <h3>🤖 AI 布局助手 <span class="badge">Qwen AI</span></h3>
    <button class="ai-chat-close" onclick="toggleAiChat()">×</button>
  </div>
  <div class="ai-chat-messages" id="aiChatMessages">
    <div class="ai-msg assistant">
      <div class="ai-msg-avatar">🤖</div>
      <div class="ai-msg-bubble">你好！我是 AI 布局助手。你可以告诉我如何调整房间布局，例如：<br>• "把会议室面积增大到 30 平米"<br>• "增加一个休息室"<br>• "删除茶水间"<br>• "办公区域需要更多工位"</div>
    </div>
  </div>
  <div class="ai-chat-hints" id="aiChatHints">
    <span class="ai-chat-hint" onclick="aiHintClick(this)">增加一个休息室</span>
    <span class="ai-chat-hint" onclick="aiHintClick(this)">会议室扩大一倍</span>
    <span class="ai-chat-hint" onclick="aiHintClick(this)">需要更多工位</span>
    <span class="ai-chat-hint" onclick="aiHintClick(this)">优化整体布局</span>
  </div>
  <div class="ai-chat-input-bar">
    <textarea class="ai-chat-input" id="aiChatInput" rows="1" placeholder="描述你想调整的内容..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendAiChat()}"></textarea>
    <button class="ai-chat-send" id="aiChatSend" onclick="sendAiChat()">▶</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
const TOKEN = localStorage.getItem("opc-token") || localStorage.getItem("token") || "";
const API = "";
let ROOMS = [];
let SPACE_ID = new URLSearchParams(window.location.search).get("space") || null;

// Dynamic brand: company name, logo, favicon from tenant config
if(TOKEN){
  fetch(API+"/api/tenant-configs",{headers:{"Authorization":"Bearer "+TOKEN}}).then(function(r){return r.json()}).then(function(d){
    if(d&&d.tenants&&d.tenants[0]){
      var t=d.tenants[0];
      // Update brand name
      if(t.company_name){
        var bn=document.getElementById("brandName");
        if(bn)bn.textContent=t.company_name;
      }
      // Update brand logo
      var logoUrl=t.logo_url||t.logo_url_light;
      if(logoUrl){
        var brandLogo=document.getElementById("brandLogo");
        var brandSvg=document.getElementById("brandSvg");
        if(brandLogo){brandLogo.src=logoUrl;brandLogo.style.display="block";}
        if(brandSvg)brandSvg.style.display="none";
      }
      // Update favicon
      if(t.logo_url||t.logo_url_light){
        var link=document.querySelector("link[rel*='icon']")||document.createElement("link");
        link.type="image/x-icon";link.rel="shortcut icon";link.href=t.logo_url||t.logo_url_light;
        document.head.appendChild(link);
      }
      // Update page title
      if(t.company_name){document.title=t.company_name+" — 数字孪生平台";}
    }
  }).catch(function(){});
}
let selectedRoom = null;
let scene, camera, renderer;
let cameraState = { rotY: Math.PI/5, rotX: Math.PI/5.5, dist: 40, panX: 0, panZ: 0 };
let viewMode = "3d"; // "3d" | "top"
let roomGroupMap = {}; // room_id -> THREE.Group

// ── Clock ──
function updateClock(){
  const d=new Date();
  const pad=n=>String(n).padStart(2,"0");
  document.getElementById("clockDisplay").textContent=
    d.getFullYear()+"/"+pad(d.getMonth()+1)+"/"+pad(d.getDate())+" "+
    pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds());
}
setInterval(updateClock,1000);updateClock();

// ── Toast ──
var _toastTimer=null;
function toast(msg){
  var t=document.getElementById("toast");
  if(!t)return;
  t.textContent=msg;t.classList.add("show");
  if(_toastTimer)clearTimeout(_toastTimer);
  _toastTimer=setTimeout(function(){t.classList.remove("show");_toastTimer=null;},3000);
}
window._toast = toast;

// ── Material Factory ──
const MAT={};
function mat(name, opts){
  if(MAT[name])return MAT[name];
  MAT[name]=new THREE.MeshStandardMaterial(opts);
  return MAT[name];
}

// ── Room type config ──
const ROOM_CONFIG={
  office:{color:0x2DD4A8,floorColor:0xB4A68A,label:"独立办公室",icon:"🏢"},
  meeting:{color:0x3DD68C,floorColor:0x8FA088,label:"会议室",icon:"📋"},
  reception:{color:0xF59E0B,floorColor:0xCFA882,label:"接待区",icon:"🛋️"},
  server_room:{color:0xEF4444,floorColor:0x505560,label:"机房",icon:"🖥️"},
  restroom:{color:0x8FA5B5,floorColor:0xAAB5C0,label:"卫生间",icon:"🚻"},
  storage:{color:0x8B5CF6,floorColor:0x8A7F6A,label:"储物间",icon:"📦"},
  pantry:{color:0x06B6D4,floorColor:0xC4A888,label:"茶水间",icon:"☕"},
  open_area:{color:0x4ECDC4,floorColor:0xA89878,label:"开放办公区",icon:"🏗️"},
  lobby:{color:0xD4A82D,floorColor:0xC8B080,label:"大堂",icon:"🏛️"},
  private_room:{color:0xC06030,floorColor:0xA08060,label:"包厢",icon:"🍽️"},
  kitchen:{color:0xE07020,floorColor:0x909090,label:"厨房",icon:"🍳"},
  dining_hall:{color:0xD4882D,floorColor:0xB8A078,label:"餐厅",icon:"🍜"},
  lounge:{color:0x9B59B6,floorColor:0xB0A090,label:"休息室",icon:"🛋️"},
  gym:{color:0xE74C3C,floorColor:0x808080,label:"健身房",icon:"🏋️"},
  library:{color:0x1ABC9C,floorColor:0x907060,label:"图书室",icon:"📚"},
  lab:{color:0x3498DB,floorColor:0xA0A0B0,label:"实验室",icon:"🔬"},
  workshop:{color:0x95A5A6,floorColor:0x707070,label:"工作坊",icon:"🔧"},
  showroom:{color:0xF1C40F,floorColor:0xC0B090,label:"展厅",icon:"🖼️"},
  warehouse:{color:0x7F8C8D,floorColor:0x606060,label:"仓库",icon:"🏭"},
  classroom:{color:0x27AE60,floorColor:0xA0B090,label:"教室",icon:"📖"},
  bedroom:{color:0x8E44AD,floorColor:0xB0A0C0,label:"卧室",icon:"🛏️"},
  corridor:{color:0xBDC3C7,floorColor:0xA0A0A0,label:"走廊",icon:"🚶"},
  balcony:{color:0x2ECC71,floorColor:0x90B080,label:"阳台",icon:"🌿"},
  garden:{color:0x27AE60,floorColor:0x70A060,label:"花园",icon:"🌳"},
  parking:{color:0x34495E,floorColor:0x505050,label:"停车场",icon:"🅿️"},
  security:{color:0xC0392B,floorColor:0x606070,label:"安保室",icon:"🔒"}
};
function roomCfg(t){return ROOM_CONFIG[t]||ROOM_CONFIG.office}

// ── Three.js Init ──
function init3D(){
  const canvas=document.getElementById("canvas3d");
  const w=window.innerWidth, h=window.innerHeight;

  scene=new THREE.Scene();
  // Sky gradient background
  const canv=document.createElement("canvas");canv.width=2;canv.height=512;
  const ctx=canv.getContext("2d");
  const grd=ctx.createLinearGradient(0,0,0,512);
  grd.addColorStop(0,"#061210");grd.addColorStop(0.4,"#0A1F1A");grd.addColorStop(1,"#040D0A");
  ctx.fillStyle=grd;ctx.fillRect(0,0,2,512);
  const skyTex=new THREE.CanvasTexture(canv);
  scene.background=skyTex;
  scene.fog=new THREE.Fog(0x040D0A,80,250);

  camera=new THREE.PerspectiveCamera(50,w/h,0.1,1000);

  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:"high-performance"});
  renderer.setSize(w,h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.outputEncoding=THREE.sRGBEncoding;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.1;

  // Lights
  const amb=new THREE.AmbientLight(0xB0E0D6,0.5);
  scene.add(amb);

  // Sun (main directional)
  const sun=new THREE.DirectionalLight(0xFFEFD5,1.2);
  sun.position.set(30,50,20);
  sun.castShadow=true;
  sun.shadow.mapSize.set(1024,1024);
  sun.shadow.camera.left=-60;sun.shadow.camera.right=60;
  sun.shadow.camera.top=60;sun.shadow.camera.bottom=-60;
  sun.shadow.camera.near=0.5;sun.shadow.camera.far=150;
  sun.shadow.bias=-0.0005;
  sun.shadow.radius=3;
  scene.add(sun);

  // Rim / fill
  const rim=new THREE.DirectionalLight(0x2DD4A8,0.4);
  rim.position.set(-20,30,-20);scene.add(rim);
  const back=new THREE.DirectionalLight(0xFFA366,0.3);
  back.position.set(10,10,-30);scene.add(back);

  // Hemisphere
  const hemi=new THREE.HemisphereLight(0xCCDDFF,0.3);
  scene.add(hemi);

  // Ground plane (large)
  const groundGeo=new THREE.PlaneGeometry(500,500);
  const groundMat=new THREE.MeshStandardMaterial({color:0x0A1A14,roughness:0.9,metalness:0.1});
  const ground=new THREE.Mesh(groundGeo,groundMat);
  ground.rotation.x=-Math.PI/2;ground.position.y=-0.2;ground.receiveShadow=true;
  scene.add(ground);

  // Grid lines on ground
  const grid=new THREE.GridHelper(200,80,0x1A3A30,0x0F2A20);
  grid.position.y=-0.18;
  grid.material.opacity=0.25;grid.material.transparent=true;
  scene.add(grid);

  updateCamera();
  setupControls(canvas);
  window.addEventListener("resize",onResize);
  animate();
}

function onResize(){
  const w=window.innerWidth,h=window.innerHeight;
  camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);
}

function updateCamera(){
  const s=cameraState;
  if(viewMode==="top"){
    camera.position.set(s.panX, 60, s.panZ+0.01);
    camera.lookAt(s.panX,0,s.panZ);
  }else{
    camera.position.x=s.panX+s.dist*Math.sin(s.rotY)*Math.cos(s.rotX);
    camera.position.y=s.dist*Math.sin(s.rotX);
    camera.position.z=s.panZ+s.dist*Math.cos(s.rotY)*Math.cos(s.rotX);
    camera.lookAt(s.panX,0,s.panZ);
  }
  var zv=document.getElementById("zoomVal");
  if(zv)zv.textContent=Math.round((40/s.dist)*100)+"%";
}
window.cameraZoom=function(dir){
  cameraState.dist=Math.max(8,Math.min(120,cameraState.dist-dir*5));
  updateCamera();
};
window.toggleViewMode=function(){
  viewMode=viewMode==="3d"?"top":"3d";
  var btn=document.getElementById("view-mode-btn");
  if(btn)btn.textContent=viewMode==="3d"?"🎥":"🗺️";
  toast(viewMode==="top"?"已切换到俯视图":"已切换到 3D 视图");
  updateCamera();
};

function setupControls(canvas){
  let dragging=false,rightDrag=false,px=0,py=0;
  canvas.addEventListener("mousedown",e=>{
    dragging=true;rightDrag=e.button===2;px=e.clientX;py=e.clientY;
  });
  canvas.addEventListener("mousemove",e=>{
    if(!dragging)return;
    const dx=e.clientX-px,dy=e.clientY-py;px=e.clientX;py=e.clientY;
    if(rightDrag){cameraState.panX+=dx*0.06;cameraState.panZ+=dy*0.06;}
    else if(viewMode==="3d"){
      cameraState.rotY-=dx*0.004;
      cameraState.rotX=Math.max(0.08,Math.min(Math.PI/2.1,cameraState.rotX-dy*0.004));
    }else{
      cameraState.panX+=dx*0.06;cameraState.panZ+=dy*0.06;
    }
    updateCamera();
  });
  canvas.addEventListener("mouseup",()=>dragging=false);
  canvas.addEventListener("mouseleave",()=>dragging=false);
  canvas.addEventListener("contextmenu",e=>e.preventDefault());
  canvas.addEventListener("wheel",e=>{
    e.preventDefault();
    cameraState.dist=Math.max(8,Math.min(120,cameraState.dist+e.deltaY*0.05));
    updateCamera();
  },{passive:false});

  // Click to select room
  const raycaster=new THREE.Raycaster();
  const mouse=new THREE.Vector2();
  let mouseDown=0,mouseDownPos={x:0,y:0};
  canvas.addEventListener("mousedown",e=>{mouseDown=Date.now();mouseDownPos={x:e.clientX,y:e.clientY}});
  canvas.addEventListener("click",e=>{
    if(Date.now()-mouseDown>250)return;
    if(Math.abs(e.clientX-mouseDownPos.x)>4||Math.abs(e.clientY-mouseDownPos.y)>4)return;
    const rect=canvas.getBoundingClientRect();
    mouse.x=((e.clientX-rect.left)/rect.width)*2-1;
    mouse.y=-((e.clientY-rect.top)/rect.height)*2+1;
    raycaster.setFromCamera(mouse,camera);
    const hits=raycaster.intersectObjects(Object.values(roomGroupMap),true);
    if(hits.length>0){
      let obj=hits[0].object;
      while(obj&&!obj.userData.roomId)obj=obj.parent;
      if(obj&&obj.userData.roomId){
        selectRoom(obj.userData.roomId);
        if(e.detail===2)openRoomModal(obj.userData.roomId);
      }
    }
  });

  // Double click for detail
  canvas.addEventListener("dblclick",e=>{
    const rect=canvas.getBoundingClientRect();
    mouse.x=((e.clientX-rect.left)/rect.width)*2-1;
    mouse.y=-((e.clientY-rect.top)/rect.height)*2+1;
    raycaster.setFromCamera(mouse,camera);
    const hits=raycaster.intersectObjects(Object.values(roomGroupMap),true);
    if(hits.length>0){
      let obj=hits[0].object;
      while(obj&&!obj.userData.roomId)obj=obj.parent;
      if(obj&&obj.userData.roomId)openRoomModal(obj.userData.roomId);
    }
  });
}

// ── Animation loop with device pulsing ──
let frameCount=0;
var pulseObjects=[];
function collectPulseObjects(){
  pulseObjects=[];
  if(!scene)return;
  scene.traverse(o=>{if(o.userData&&o.userData.sensorPulse)pulseObjects.push(o)});
}
function animate(){
  requestAnimationFrame(animate);
  frameCount++;
  if(frameCount%2===0){
    for(let i=0;i<pulseObjects.length;i++){
      const o=pulseObjects[i];
      const t=(Math.sin(frameCount*0.05+(o.userData.phase||0))+1)*0.5;
      if(o.material&&o.material.emissiveIntensity!==undefined){
        o.material.emissiveIntensity=0.4+t*1.0;
      }
    }
  }
  renderer.render(scene,camera);
}

// ── Build 3D Scene ──
function build3DScene(){
  Object.values(roomGroupMap).forEach(g=>scene.remove(g));
  roomGroupMap={};

  const FLOOR_HEIGHT=3.5;
  var floors={};
  ROOMS.forEach(function(r){var f=r.floor||1;if(!floors[f])floors[f]=[];floors[f].push(r);});
  var floorKeys=Object.keys(floors).map(Number).sort(function(a,b){return a-b;});

  let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
  ROOMS.forEach(r=>{
    const x=r.position_x||0, z=r.position_y||0;
    const w=r.width||Math.sqrt(r.area*1.2),d=r.depth||r.area/w;
    minX=Math.min(minX,x);minZ=Math.min(minZ,z);
    maxX=Math.max(maxX,x+w);maxZ=Math.max(maxZ,z+d);
  });
  if(!isFinite(minX)){minX=0;minZ=0;maxX=0;maxZ=0;}
  const cx=(minX+maxX)/2, cz=(minZ+maxZ)/2;

  ROOMS.forEach(room=>{
    const floorIndex=(room.floor||1)-1;
    const yOffset=floorIndex*FLOOR_HEIGHT;
    const group=buildRoom(room, cx, cz);
    group.position.y+=yOffset;
    roomGroupMap[room.id]=group;
    scene.add(group);
  });

  if(floorKeys.length>1){
    floorKeys.forEach(function(f,i){
      if(i===0)return;
      var yPos=i*FLOOR_HEIGHT-0.04;
      var slabW=maxX-minX+1, slabD=maxZ-minZ+1;
      var slabGeo=new THREE.BoxGeometry(slabW,0.08,slabD);
      var slabMat=new THREE.MeshStandardMaterial({color:0x888888,roughness:0.8,metalness:0.1,transparent:true,opacity:0.35});
      var slab=new THREE.Mesh(slabGeo,slabMat);
      slab.position.set(0,yPos,0);
      slab.receiveShadow=true;
      scene.add(slab);
    });
  }

  cameraState.panX=0;cameraState.panZ=0;
  const extent=Math.max(maxX-minX,maxZ-minZ);
  const floorCount=floorKeys.length;
  cameraState.dist=Math.max(25,extent*1.3+floorCount*3);
  updateCamera();

  collectPulseObjects();
  updateOverlay();
}

function buildRoom(room, offsetX, offsetZ){
  const cfg=roomCfg(room.room_type);
  const w=room.width||Math.sqrt(room.area*1.2);
  const d=room.depth||room.area/w;
  const h=room.height||2.8;
  const wallThick=0.12;

  const group=new THREE.Group();
  group.userData={roomId:room.id,roomType:room.room_type};
  group.position.set((room.position_x||0)-offsetX, 0, (room.position_y||0)-offsetZ);

  // ── Floor (wood texture simulated via color+roughness) ──
  const floorGeo=new THREE.BoxGeometry(w,0.08,d);
  const floorMat=new THREE.MeshStandardMaterial({
    color:cfg.floorColor,roughness:0.72,metalness:0.05
  });
  const floor=new THREE.Mesh(floorGeo,floorMat);
  floor.position.set(w/2,0.04,d/2);
  floor.receiveShadow=true;
  group.add(floor);


  // ── Walls (4 separate wall meshes) ──
  const wallMat=new THREE.MeshStandardMaterial({
    color:0xF5F0E8,roughness:0.85,metalness:0.02
  });
  const wallInnerMat=new THREE.MeshStandardMaterial({
    color:cfg.color,roughness:0.6,transparent:true,opacity:0.0
  });

  // North wall (back)
  const wallN=new THREE.Mesh(new THREE.BoxGeometry(w,h,wallThick),wallMat);
  wallN.position.set(w/2,h/2+0.04,wallThick/2);
  wallN.castShadow=true;wallN.receiveShadow=true;
  group.add(wallN);

  // South wall (front) - with opening for door (hollow in the middle)
  const doorWidth=Math.min(1.2,w*0.3);
  const sideW=(w-doorWidth)/2;
  if(sideW>0.1){
    const wallS1=new THREE.Mesh(new THREE.BoxGeometry(sideW,h,wallThick),wallMat);
    wallS1.position.set(sideW/2,h/2+0.04,d-wallThick/2);
    wallS1.castShadow=true;wallS1.receiveShadow=true;
    group.add(wallS1);
    const wallS2=new THREE.Mesh(new THREE.BoxGeometry(sideW,h,wallThick),wallMat);
    wallS2.position.set(w-sideW/2,h/2+0.04,d-wallThick/2);
    wallS2.castShadow=true;wallS2.receiveShadow=true;
    group.add(wallS2);
    // Door frame top
    const lintel=new THREE.Mesh(new THREE.BoxGeometry(doorWidth,h-2.1,wallThick),wallMat);
    lintel.position.set(w/2,(h-2.1)/2+2.1+0.04,d-wallThick/2);
    group.add(lintel);
  }

  // East wall
  const wallE=new THREE.Mesh(new THREE.BoxGeometry(wallThick,h,d),wallMat);
  wallE.position.set(w-wallThick/2,h/2+0.04,d/2);
  wallE.castShadow=true;wallE.receiveShadow=true;
  group.add(wallE);

  // West wall with window (glass pane in the middle)
  const wallWLower=new THREE.Mesh(new THREE.BoxGeometry(wallThick,0.9,d),wallMat);
  wallWLower.position.set(wallThick/2,0.45+0.04,d/2);
  wallWLower.castShadow=true;wallWLower.receiveShadow=true;
  group.add(wallWLower);
  const wallWUpper=new THREE.Mesh(new THREE.BoxGeometry(wallThick,h-2.1,d),wallMat);
  wallWUpper.position.set(wallThick/2,2.1+(h-2.1)/2+0.04,d/2);
  wallWUpper.castShadow=true;wallWUpper.receiveShadow=true;
  group.add(wallWUpper);
  // Window glass
  const glassMat=new THREE.MeshStandardMaterial({
    color:0x88BBEE,transparent:true,opacity:0.35,
    roughness:0.05,metalness:0.5,emissive:0x2A6A5A,emissiveIntensity:0.15
  });
  const glass=new THREE.Mesh(new THREE.BoxGeometry(wallThick*0.5,1.2,d-0.3),glassMat);
  glass.position.set(wallThick/2,0.9+0.6+0.04,d/2);
  group.add(glass);

  // ── Ceiling (semi-transparent so interior visible) ──
  const ceilMat=new THREE.MeshStandardMaterial({
    color:0xFFFFFF,roughness:0.9,transparent:true,opacity:0.0
  });
  const ceiling=new THREE.Mesh(new THREE.BoxGeometry(w,0.05,d),ceilMat);
  ceiling.position.set(w/2,h+0.04,d/2);
  group.add(ceiling);

  // ── Color accent strip on top of walls (colored baseboard on ceiling edge) ──
  const accentMat=new THREE.MeshStandardMaterial({
    color:cfg.color,emissive:cfg.color,emissiveIntensity:0.4,roughness:0.3
  });
  const accent=new THREE.Mesh(new THREE.BoxGeometry(w,0.04,wallThick*1.3),accentMat);
  accent.position.set(w/2,h-0.1,wallThick/2);
  group.add(accent);

  // ── Furniture based on room type ──
  placeFurniture(group, room, w, d, h, cfg);

  // ── Ceiling light ──
  const lightBase=new THREE.Mesh(
    new THREE.CylinderGeometry(0.15,0.18,0.08,16),
    new THREE.MeshStandardMaterial({color:0xEEEEEE,roughness:0.6})
  );
  lightBase.position.set(w/2,h-0.05,d/2);
  group.add(lightBase);
  const lightBulb=new THREE.Mesh(
    new THREE.SphereGeometry(0.12,12,12),
    new THREE.MeshStandardMaterial({
      color:0xFFFFCC,emissive:0xFFE8A0,emissiveIntensity:1.5
    })
  );
  lightBulb.position.set(w/2,h-0.12,d/2);
  group.add(lightBulb);
  // Actual light source
  const ptLight=new THREE.PointLight(0xFFE8A0,0.6,Math.max(w,d)*1.5,2);
  ptLight.position.set(w/2,h-0.2,d/2);
  group.add(ptLight);

  // ── IoT Devices (from products_json) ──
  placeIotDevices(group, room, w, d, h);

  // ── 3D Label (floating name tag) ──
  const labelSprite=makeLabel(room.name+"\\n"+room.area+"㎡", cfg.color);
  labelSprite.position.set(w/2,h+1.2,d/2);
  labelSprite.scale.set(3.2,0.8,1);
  labelSprite.userData={isLabel:true};
  group.add(labelSprite);

  // ── Room type icon ring on ground (visual marker) ──
  const ringGeo=new THREE.RingGeometry(Math.min(w,d)*0.35,Math.min(w,d)*0.42,32);
  const ringMat=new THREE.MeshBasicMaterial({
    color:cfg.color,transparent:true,opacity:0.0,side:THREE.DoubleSide
  });
  const ring=new THREE.Mesh(ringGeo,ringMat);
  ring.rotation.x=-Math.PI/2;
  ring.position.set(w/2,0.09,d/2);
  ring.userData={isHighlightRing:true};
  group.add(ring);

  return group;
}

// ── Furniture placement ──
function placeFurniture(group, room, w, d, h, cfg){
  const type=room.room_type;
  if(type==="office"||type==="open_area"){
    const maxDesks=type==="open_area"?6:3;
    const rows=Math.max(1,Math.floor(d/2.5));
    const cols=Math.max(1,Math.floor(w/1.8));
    let placed=0;
    for(let r=0;r<rows&&placed<maxDesks;r++){
      for(let c=0;c<cols&&placed<maxDesks;c++){
        const x=0.8+c*1.8;const z=0.8+r*2.5;
        if(x+1>w-0.3||z+1.2>d-0.3)continue;
        addDesk(group,x,z,cfg);
        addChair(group,x+0.3,z+1.1,cfg);
        placed++;
      }
    }
  }else if(type==="meeting"){
    // Conference table
    addConferenceTable(group,w/2-Math.min(1.5,w*0.3),d/2-Math.min(0.9,d*0.25),Math.min(3,w*0.6),Math.min(1.4,d*0.5),cfg);
    // Chairs around table
    const chairs=Math.min(6,Math.floor((w+d)/1.5));
    const tableW=Math.min(3,w*0.6),tableD=Math.min(1.4,d*0.5);
    const tx=w/2,tz=d/2;
    for(let i=0;i<chairs;i++){
      const angle=(i/chairs)*Math.PI*2;
      const radius=Math.max(tableW,tableD)/2+0.6;
      addChair(group,tx+Math.cos(angle)*radius-0.25,tz+Math.sin(angle)*radius-0.25,cfg);
    }
    // Screen on wall
    addWallScreen(group,w/2,h*0.6,0.15,cfg);
  }else if(type==="reception"){
    // Reception counter
    addReceptionCounter(group,w/2-1,0.5,2,0.6,cfg);
    // Sofas
    if(w>=4){
      addSofa(group,0.5,d-1.5,cfg);
      if(w>=5)addSofa(group,w-2.5,d-1.5,cfg);
    }
    // Coffee table
    if(w>=4&&d>=3)addCoffeeTable(group,w/2-0.4,d-1.2);
  }else if(type==="pantry"){
    // Counter along wall
    addPantryCounter(group,0.3,d-0.6,w-0.6,0.5,cfg);
    // Round table
    if(w>=3&&d>=3)addRoundTable(group,w/2,d/2-0.3);
  }else if(type==="server_room"){
    // Server racks
    const rackCount=Math.min(4,Math.floor(w/0.8));
    for(let i=0;i<rackCount;i++){
      addServerRack(group,0.5+i*1.0,d-1,cfg);
    }
  }else if(type==="restroom"){
    // Stalls
    const stalls=Math.max(1,Math.floor(w/0.9));
    for(let i=0;i<stalls;i++){
      addRestroomStall(group,0.3+i*0.9,d-1.2);
    }
  }else if(type==="storage"||type==="warehouse"){
    addCabinet(group,0.2,0.3,w-0.4,0.5,cfg);
    if(d>=2.5)addCabinet(group,0.2,d-0.8,w-0.4,0.5,cfg);
  }else if(type==="lobby"||type==="dining_hall"){
    if(w>=4&&d>=3)addRoundTable(group,w/2,d/2-0.3);
    if(w>=5){addSofa(group,0.5,d-1.5,cfg);if(w>=7)addSofa(group,w-2.5,d-1.5,cfg);}
    addReceptionCounter(group,w/2-1,0.5,2,0.6,cfg);
  }else if(type==="private_room"){
    addRoundTable(group,w/2,d/2);
    var seats=Math.min(6,Math.max(2,Math.floor((w+d)/1.5)));
    for(var i=0;i<seats;i++){
      var ang=(i/seats)*Math.PI*2;
      var rad=Math.min(w,d)*0.3;
      addChair(group,w/2+Math.cos(ang)*rad-0.25,d/2+Math.sin(ang)*rad-0.25,cfg);
    }
  }else if(type==="kitchen"){
    addPantryCounter(group,0.3,0.3,w-0.6,0.5,cfg);
    addPantryCounter(group,0.3,d-0.8,w-0.6,0.5,cfg);
  }else if(type==="lounge"||type==="bedroom"){
    if(w>=3)addSofa(group,w/2-1,d/2-0.5,cfg);
    if(w>=3&&d>=3)addCoffeeTable(group,w/2-0.4,d/2+0.5);
  }else if(type==="classroom"){
    var deskRows=Math.max(1,Math.floor(d/2));
    var deskCols=Math.max(1,Math.floor(w/1.8));
    var placed=0;
    for(var dr=0;dr<deskRows&&placed<12;dr++){
      for(var dc=0;dc<deskCols&&placed<12;dc++){
        var dx=0.5+dc*1.8,dz=1+dr*2;
        if(dx+1>w-0.3||dz+1>d-0.3)continue;
        addDesk(group,dx,dz,cfg);addChair(group,dx+0.3,dz+1,cfg);
        placed++;
      }
    }
    addWallScreen(group,w/2,h*0.6,0.15,cfg);
  }else if(type==="gym"||type==="workshop"||type==="lab"){
    addPantryCounter(group,0.3,d-0.8,w-0.6,0.5,cfg);
  }else if(type==="showroom"||type==="library"){
    addCabinet(group,0.2,0.3,w-0.4,0.5,cfg);
    if(d>=3)addCabinet(group,0.2,d-0.8,w-0.4,0.5,cfg);
    if(w>=4&&d>=3)addCoffeeTable(group,w/2-0.4,d/2);
  }
}

// ── Furniture primitives ──
function addDesk(group,x,z,cfg){
  // Desk top
  const top=new THREE.Mesh(
    new THREE.BoxGeometry(1.4,0.04,0.7),
    new THREE.MeshStandardMaterial({color:0xE8DDC8,roughness:0.4,metalness:0.05})
  );
  top.position.set(x+0.7,0.74,z+0.35);
  top.castShadow=true;top.receiveShadow=true;
  group.add(top);
  // Legs (simple plate frame)
  const leg=new THREE.Mesh(
    new THREE.BoxGeometry(1.35,0.7,0.04),
    new THREE.MeshStandardMaterial({color:0x404550,roughness:0.4,metalness:0.6})
  );
  leg.position.set(x+0.7,0.36,z+0.04);
  leg.castShadow=true;
  group.add(leg);
  const leg2=leg.clone();leg2.position.z=z+0.66;group.add(leg2);
  // Monitor
  const screen=new THREE.Mesh(
    new THREE.BoxGeometry(0.6,0.4,0.03),
    new THREE.MeshStandardMaterial({color:0x1A1A1A,roughness:0.2,emissive:0x1A8A6A,emissiveIntensity:0.4})
  );
  screen.position.set(x+0.7,1.0,z+0.2);
  screen.castShadow=true;
  group.add(screen);
  // Monitor stand
  const stand=new THREE.Mesh(
    new THREE.BoxGeometry(0.1,0.2,0.1),
    new THREE.MeshStandardMaterial({color:0x202020,roughness:0.4})
  );
  stand.position.set(x+0.7,0.86,z+0.2);
  group.add(stand);
}

function addChair(group,x,z,cfg){
  // Seat
  const seat=new THREE.Mesh(
    new THREE.BoxGeometry(0.5,0.06,0.5),
    new THREE.MeshStandardMaterial({color:0x2A2E3A,roughness:0.7})
  );
  seat.position.set(x+0.25,0.45,z+0.25);
  seat.castShadow=true;seat.receiveShadow=true;
  group.add(seat);
  // Back
  const back=new THREE.Mesh(
    new THREE.BoxGeometry(0.5,0.5,0.06),
    new THREE.MeshStandardMaterial({color:0x2A2E3A,roughness:0.7})
  );
  back.position.set(x+0.25,0.7,z+0.04);
  back.castShadow=true;
  group.add(back);
  // Base
  const base=new THREE.Mesh(
    new THREE.CylinderGeometry(0.04,0.04,0.38,8),
    new THREE.MeshStandardMaterial({color:0x202020,roughness:0.3,metalness:0.7})
  );
  base.position.set(x+0.25,0.23,z+0.25);
  group.add(base);
  const foot=new THREE.Mesh(
    new THREE.CylinderGeometry(0.22,0.25,0.04,12),
    new THREE.MeshStandardMaterial({color:0x202020,roughness:0.3,metalness:0.7})
  );
  foot.position.set(x+0.25,0.03,z+0.25);
  group.add(foot);
}

function addConferenceTable(group,x,z,w,d,cfg){
  const table=new THREE.Mesh(
    new THREE.BoxGeometry(w,0.06,d),
    new THREE.MeshStandardMaterial({color:0x3A2818,roughness:0.3,metalness:0.1})
  );
  table.position.set(x+w/2,0.75,z+d/2);
  table.castShadow=true;table.receiveShadow=true;
  group.add(table);
  // Legs
  for(let i=0;i<2;i++){
    for(let j=0;j<2;j++){
      const leg=new THREE.Mesh(
        new THREE.CylinderGeometry(0.04,0.05,0.72,8),
        new THREE.MeshStandardMaterial({color:0x1A1A1A,roughness:0.4,metalness:0.6})
      );
      leg.position.set(x+0.2+i*(w-0.4),0.36,z+0.2+j*(d-0.4));
      group.add(leg);
    }
  }
  // Center speakerphone
  const phone=new THREE.Mesh(
    new THREE.CylinderGeometry(0.12,0.15,0.04,16),
    new THREE.MeshStandardMaterial({color:0x2A2A2A,roughness:0.6,emissive:0x1A8A6A,emissiveIntensity:0.3})
  );
  phone.position.set(x+w/2,0.8,z+d/2);
  group.add(phone);
}

function addWallScreen(group,x,y,z,cfg){
  const tv=new THREE.Mesh(
    new THREE.BoxGeometry(1.8,1.05,0.05),
    new THREE.MeshStandardMaterial({color:0x0A0A0A,roughness:0.2})
  );
  tv.position.set(x,y,z);
  group.add(tv);
  const screen=new THREE.Mesh(
    new THREE.PlaneGeometry(1.7,0.95),
    new THREE.MeshStandardMaterial({color:0x0A3A30,emissive:0x2DD4A8,emissiveIntensity:0.6})
  );
  screen.position.set(x,y,z+0.03);
  group.add(screen);
}

function addReceptionCounter(group,x,z,w,d,cfg){
  const body=new THREE.Mesh(
    new THREE.BoxGeometry(w,1.1,d),
    new THREE.MeshStandardMaterial({color:0xE5C77A,roughness:0.4})
  );
  body.position.set(x+w/2,0.55,z+d/2);
  body.castShadow=true;body.receiveShadow=true;
  group.add(body);
  const top=new THREE.Mesh(
    new THREE.BoxGeometry(w+0.1,0.04,d+0.1),
    new THREE.MeshStandardMaterial({color:0x1A1A1A,roughness:0.3,metalness:0.3})
  );
  top.position.set(x+w/2,1.12,z+d/2);
  group.add(top);
}

function addSofa(group,x,z,cfg){
  // Base
  const base=new THREE.Mesh(
    new THREE.BoxGeometry(2,0.4,0.9),
    new THREE.MeshStandardMaterial({color:0x546275,roughness:0.85})
  );
  base.position.set(x+1,0.2,z+0.45);
  base.castShadow=true;base.receiveShadow=true;
  group.add(base);
  // Back
  const back=new THREE.Mesh(
    new THREE.BoxGeometry(2,0.55,0.2),
    new THREE.MeshStandardMaterial({color:0x485568,roughness:0.85})
  );
  back.position.set(x+1,0.7,z+0.1);
  back.castShadow=true;
  group.add(back);
  // Cushions
  for(let i=0;i<2;i++){
    const cush=new THREE.Mesh(
      new THREE.BoxGeometry(0.9,0.2,0.8),
      new THREE.MeshStandardMaterial({color:0x607088,roughness:0.8})
    );
    cush.position.set(x+0.55+i*0.9,0.5,z+0.5);
    cush.castShadow=true;
    group.add(cush);
  }
}

function addCoffeeTable(group,x,z){
  const tbl=new THREE.Mesh(
    new THREE.BoxGeometry(0.8,0.05,0.5),
    new THREE.MeshStandardMaterial({color:0x3A2818,roughness:0.3})
  );
  tbl.position.set(x+0.4,0.4,z+0.25);
  tbl.castShadow=true;tbl.receiveShadow=true;
  group.add(tbl);
  // Legs
  for(let i=0;i<4;i++){
    const leg=new THREE.Mesh(
      new THREE.CylinderGeometry(0.02,0.02,0.4,6),
      new THREE.MeshStandardMaterial({color:0x202020})
    );
    leg.position.set(x+0.1+(i%2)*0.6,0.2,z+0.08+Math.floor(i/2)*0.34);
    group.add(leg);
  }
}

function addPantryCounter(group,x,z,w,d,cfg){
  const body=new THREE.Mesh(
    new THREE.BoxGeometry(w,0.85,d),
    new THREE.MeshStandardMaterial({color:0xF0E8D8,roughness:0.5})
  );
  body.position.set(x+w/2,0.425,z+d/2);
  body.castShadow=true;body.receiveShadow=true;
  group.add(body);
  const top=new THREE.Mesh(
    new THREE.BoxGeometry(w,0.04,d),
    new THREE.MeshStandardMaterial({color:0x2A2A2A,roughness:0.3,metalness:0.2})
  );
  top.position.set(x+w/2,0.87,z+d/2);
  group.add(top);
  // Sink
  const sink=new THREE.Mesh(
    new THREE.BoxGeometry(0.5,0.04,0.35),
    new THREE.MeshStandardMaterial({color:0xB0B8C0,roughness:0.2,metalness:0.7})
  );
  sink.position.set(x+w*0.3,0.88,z+d/2);
  group.add(sink);
}

function addRoundTable(group,x,z){
  const tbl=new THREE.Mesh(
    new THREE.CylinderGeometry(0.5,0.5,0.05,24),
    new THREE.MeshStandardMaterial({color:0x8B6F47,roughness:0.4})
  );
  tbl.position.set(x,0.75,z);
  tbl.castShadow=true;tbl.receiveShadow=true;
  group.add(tbl);
  const leg=new THREE.Mesh(
    new THREE.CylinderGeometry(0.05,0.2,0.72,12),
    new THREE.MeshStandardMaterial({color:0x3A2818,roughness:0.4})
  );
  leg.position.set(x,0.36,z);
  group.add(leg);
}

function addServerRack(group,x,z,cfg){
  // Rack body
  const body=new THREE.Mesh(
    new THREE.BoxGeometry(0.6,2.2,0.6),
    new THREE.MeshStandardMaterial({color:0x1A1A1A,roughness:0.5,metalness:0.4})
  );
  body.position.set(x+0.3,1.1,z+0.3);
  body.castShadow=true;body.receiveShadow=true;
  group.add(body);
  // Blinking LEDs
  for(let i=0;i<5;i++){
    const led=new THREE.Mesh(
      new THREE.BoxGeometry(0.02,0.02,0.01),
      new THREE.MeshStandardMaterial({
        color:0x3DD68C,emissive:0x3DD68C,emissiveIntensity:1.5
      })
    );
    led.position.set(x+0.3-0.2+(i*0.08),0.4+i*0.3,z+0.6);
    led.userData={sensorPulse:true,phase:i*0.7};
    group.add(led);
  }
  // Front panel
  const panel=new THREE.Mesh(
    new THREE.BoxGeometry(0.5,1.8,0.02),
    new THREE.MeshStandardMaterial({color:0x0A0A0A,roughness:0.2,emissive:0x0A3A2A,emissiveIntensity:0.3})
  );
  panel.position.set(x+0.3,1.1,z+0.61);
  group.add(panel);
}

function addRestroomStall(group,x,z){
  const stall=new THREE.Mesh(
    new THREE.BoxGeometry(0.8,1.8,1),
    new THREE.MeshStandardMaterial({color:0xCCD6E0,roughness:0.4})
  );
  stall.position.set(x+0.4,0.9,z+0.5);
  stall.castShadow=true;stall.receiveShadow=true;
  group.add(stall);
}

function addCabinet(group,x,z,w,d,cfg){
  const body=new THREE.Mesh(
    new THREE.BoxGeometry(w,2,d),
    new THREE.MeshStandardMaterial({color:0x6B5A3F,roughness:0.6})
  );
  body.position.set(x+w/2,1,z+d/2);
  body.castShadow=true;body.receiveShadow=true;
  group.add(body);
  // Drawer lines
  for(let i=1;i<4;i++){
    const line=new THREE.Mesh(
      new THREE.BoxGeometry(w-0.05,0.02,0.005),
      new THREE.MeshStandardMaterial({color:0x3A2A1A})
    );
    line.position.set(x+w/2,i*0.5,z+d+0.001);
    group.add(line);
  }
}

// ── IoT devices on ceiling/walls ──
function placeIotDevices(group, room, w, d, h){
  const products=JSON.parse(room.products_json||"[]");
  let sensorCount=0,cameraCount=0,speakerCount=0;
  products.forEach(p=>{
    const cat=p.category||"";
    if(cat==="iot_sensor"){sensorCount+=p.quantity}
    else if(cat==="iot_control"){speakerCount+=p.quantity}
    else if(p.name && p.name.indexOf("摄像")>=0){cameraCount+=p.quantity}
  });

  for(let i=0;i<Math.min(sensorCount,3);i++){
    const sensor=new THREE.Mesh(
      new THREE.SphereGeometry(0.08,8,8),
      new THREE.MeshStandardMaterial({color:0x3DD68C,emissive:0x3DD68C,emissiveIntensity:0.8})
    );
    const angle=i*1.2;
    sensor.position.set(w*0.3+Math.cos(angle)*w*0.2, h-0.25, d*0.3+Math.sin(angle)*d*0.2);
    sensor.userData={sensorPulse:true,phase:i*1.3,isSensor:true};
    group.add(sensor);
  }

  // Cameras on walls (pointing down-ish)
  for(let i=0;i<Math.min(cameraCount,1);i++){
    const cam=new THREE.Mesh(
      new THREE.CylinderGeometry(0.06,0.08,0.12,8),
      new THREE.MeshStandardMaterial({color:0x2A2A2A,roughness:0.4,emissive:0xFF0000,emissiveIntensity:0.2})
    );
    cam.rotation.x=Math.PI/2;
    cam.position.set(0.2, h-0.3, 0.3);
    cam.userData={sensorPulse:true,phase:i*0.5};
    group.add(cam);
  }

  // Smart speakers/controls
  for(let i=0;i<Math.min(speakerCount,3);i++){
    const sp=new THREE.Mesh(
      new THREE.BoxGeometry(0.1,0.15,0.02),
      new THREE.MeshStandardMaterial({color:0xFFFFFF,roughness:0.6,emissive:0x2DD4A8,emissiveIntensity:0.5})
    );
    sp.position.set(w-0.05, 1.2+i*0.3, 0.5);
    group.add(sp);
  }
}

// ── 3D Label Sprite ──
function makeLabel(text,color){
  const canv=document.createElement("canvas");
  canv.width=512;canv.height=128;
  const ctx=canv.getContext("2d");
  ctx.clearRect(0,0,512,128);
  const lines=text.split("\\n");
  ctx.fillStyle="rgba(8,22,18,0.88)";
  roundRect(ctx,16,8,480,112,14);ctx.fill();
  ctx.strokeStyle="#"+(color).toString(16).padStart(6,"0");
  ctx.lineWidth=2;
  roundRect(ctx,16,8,480,112,14);ctx.stroke();
  ctx.textAlign="center";ctx.textBaseline="middle";
  ctx.fillStyle="#E8F5F0";
  ctx.font="bold 36px system-ui,'PingFang SC','Microsoft YaHei',sans-serif";
  ctx.fillText(lines[0]||"",256, lines[1]?48:64);
  if(lines[1]){
    ctx.fillStyle="#8EBFAD";
    ctx.font="24px system-ui,'PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillText(lines[1],256,90);
  }
  const tex=new THREE.CanvasTexture(canv);
  tex.minFilter=THREE.LinearFilter;
  const mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false,depthWrite:false});
  const sprite=new THREE.Sprite(mat);
  sprite.renderOrder=999;
  return sprite;
}

function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function updateOverlay(){
  document.getElementById("vpArea").textContent=document.getElementById("totalArea").value;
  document.getElementById("vpRooms").textContent=ROOMS.length;
  let devCount=0;
  ROOMS.forEach(r=>{const p=JSON.parse(r.products_json||"[]");p.forEach(x=>devCount+=x.quantity)});
  document.getElementById("vpDevices").textContent=devCount;
  updateHeaderTitle();
}
window.updateHeaderTitle=function(){
  var name=document.getElementById("spaceName").value.trim();
  document.getElementById("headerTitle").textContent=name||"数字孪生平台";
  document.title=(name||"数字孪生平台")+" — OPC Digital Twin";
};

// ── Room List ──
function renderRoomList(){
  const el=document.getElementById("roomList");
  document.getElementById("roomCount").textContent=ROOMS.length+" 间";
  if(!ROOMS.length){
    el.innerHTML='<div class="empty-state"><div class="icon" style="font-size:36px">🏠</div><p style="font-size:12px">点击「自动生成 3D 布局」开始</p></div>';
    return;
  }
  var hasMultiFloor=ROOMS.some(function(r){return(r.floor||1)>1;});
  el.innerHTML=ROOMS.map(r=>{
    const products=JSON.parse(r.products_json||"[]");
    const cfg=roomCfg(r.room_type);
    const isActive=selectedRoom===r.id;
    var floorTag=hasMultiFloor?'<span class="badge" style="background:rgba(255,255,255,0.08);font-size:9px">'+(r.floor||1)+'F</span>':'';
    return '<div class="room-card'+(isActive?" active":"")+'" onclick="selectRoom(\\''+r.id+'\\')" ondblclick="openRoomModal(\\''+r.id+'\\')">'
      +'<div class="room-card-header"><h3>'+cfg.icon+' '+r.name+'</h3><div style="display:flex;gap:4px;align-items:center">'+floorTag+'<span class="badge">'+r.area+'㎡</span></div></div>'
      +'<div class="room-card-meta"><span>'+cfg.label+'</span><span>'+products.length+' 类设备</span></div>'
      +'<div class="room-card-products">'+products.slice(0,4).map(p=>'<span class="tag">'+(p.icon||"📦")+' '+p.name+(p.quantity>1?" ×"+p.quantity:"")+'</span>').join("")
      +(products.length>4?'<span class="tag">+'+(products.length-4)+'</span>':"")
      +'</div></div>';
  }).join("");
}

window.selectRoom=function(id){
  selectedRoom=id;
  renderRoomList();
  renderProductPanel(id);
  highlight3DRoom(id);
  focusCameraOnRoom(id);
};

function focusCameraOnRoom(id){
  const g=roomGroupMap[id];if(!g)return;
  const room=ROOMS.find(r=>r.id===id);if(!room)return;
  // Get center of room in world space
  const bbox=new THREE.Box3().setFromObject(g);
  const center=bbox.getCenter(new THREE.Vector3());
  cameraState.panX=center.x;
  cameraState.panZ=center.z;
  cameraState.dist=Math.max(10,Math.max(room.width||5,room.depth||5)*2.2);
  updateCamera();
}

function highlight3DRoom(id){
  Object.entries(roomGroupMap).forEach(([rid,g])=>{
    const isSelected=rid===id;
    g.traverse(o=>{
      if(o.userData&&o.userData.isHighlightRing&&o.material){
        o.material.opacity=isSelected?0.6:0;
      }
    });
    var rm=ROOMS.find(function(rr){return rr.id===rid;});
    var baseY=((rm&&rm.floor||1)-1)*3.5;
    if(isSelected)g.position.y=baseY+0.05;else g.position.y=baseY;
  });
}

function renderProductPanel(roomId){
  const room=ROOMS.find(r=>r.id===roomId);
  const hint=document.getElementById("roomHint");
  const bar=document.getElementById("summaryBar");
  if(!room){
    document.getElementById("productList").innerHTML='<div class="empty-state"><div class="icon">📡</div><p style="font-size:12px">选择一个房间查看设备推荐</p></div>';
    bar.style.display="none";hint.textContent="点击房间查看推荐";
    return;
  }
  const cfg=roomCfg(room.room_type);
  hint.textContent=cfg.icon+" "+room.name+" · "+cfg.label+" · "+room.area+"㎡";
  const products=JSON.parse(room.products_json||"[]");
  const el=document.getElementById("productList");
  if(!products.length){
    el.innerHTML='<div class="empty-state"><div class="icon">📦</div><p style="font-size:12px">暂无推荐设备</p></div>';
    bar.style.display="none";return;
  }
  el.innerHTML=products.map(p=>
    '<div class="product-item">'
    +'<div class="product-icon">'+(p.icon||"📦")+'</div>'
    +'<div class="product-info"><div class="product-name">'+p.name+(p.is_iot?'<span class="product-iot">IoT</span>':"")+'</div>'
    +'<div class="product-detail">'+(p.reason||"")+'</div>'
    +(p.price_range?'<div class="product-detail" style="color:var(--tx3);margin-top:2px">参考价：¥'+p.price_range+'</div>':"")
    +'</div>'
    +'<div class="product-qty">×'+p.quantity+'</div>'
    +'</div>'
  ).join("");

  bar.style.display="block";
  let furn=0,sensor=0,net=0;
  products.forEach(p=>{
    if(p.category==="furniture"||p.category==="equipment") furn+=p.quantity;
    else if(p.category==="iot_sensor"||p.category==="iot_control") sensor+=p.quantity;
    else if(p.category==="network") net+=p.quantity;
  });
  document.getElementById("sumFurniture").textContent=furn;
  document.getElementById("sumSensors").textContent=sensor;
  document.getElementById("sumNetwork").textContent=net;
  document.getElementById("sumTotal").textContent=furn+sensor+net;
}

// ── Room Detail Modal ──
window.openRoomModal=function(id){
  const room=ROOMS.find(r=>r.id===id);
  if(!room)return;
  const cfg=roomCfg(room.room_type);
  const products=JSON.parse(room.products_json||"[]");
  document.getElementById("rmName").textContent=cfg.icon+" "+room.name;
  document.getElementById("rmSub").textContent=cfg.label+" · "+room.area+"㎡ · "+(room.width||0).toFixed(1)+"m × "+(room.depth||0).toFixed(1)+"m";

  // Simulated sensor data
  const temp=(22+Math.random()*2).toFixed(1);
  const humidity=(45+Math.random()*10).toFixed(0);
  const co2=(450+Math.random()*200).toFixed(0);
  const pm25=(15+Math.random()*20).toFixed(0);

  let sensorCount=0,furnCount=0,netCount=0;
  products.forEach(p=>{
    if(p.category==="furniture"||p.category==="equipment")furnCount+=p.quantity;
    else if(p.category==="iot_sensor"||p.category==="iot_control")sensorCount+=p.quantity;
    else if(p.category==="network")netCount+=p.quantity;
  });

  const body='<div class="room-stat-grid">'
    +'<div class="room-stat"><div class="room-stat-val">'+furnCount+'</div><div class="room-stat-label">家具</div></div>'
    +'<div class="room-stat"><div class="room-stat-val" style="color:var(--green)">'+sensorCount+'</div><div class="room-stat-label">传感器</div></div>'
    +'<div class="room-stat"><div class="room-stat-val" style="color:var(--orange)">'+netCount+'</div><div class="room-stat-label">网络</div></div>'
    +'<div class="room-stat"><div class="room-stat-val">'+room.area+'</div><div class="room-stat-label">㎡</div></div>'
    +'</div>'
    +'<div class="section-label" style="padding-left:0">🌡️ 实时传感数据（模拟）</div>'
    +'<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px">'
      +'<div class="sensor-live"><div class="pulse"></div><div><div style="font-size:10px;color:var(--tx3)">温度</div><div><strong>'+temp+'</strong> °C</div></div></div>'
      +'<div class="sensor-live"><div class="pulse"></div><div><div style="font-size:10px;color:var(--tx3)">湿度</div><div><strong>'+humidity+'</strong> %</div></div></div>'
      +'<div class="sensor-live"><div class="pulse"></div><div><div style="font-size:10px;color:var(--tx3)">CO₂</div><div><strong>'+co2+'</strong> ppm</div></div></div>'
      +'<div class="sensor-live"><div class="pulse"></div><div><div style="font-size:10px;color:var(--tx3)">PM2.5</div><div><strong>'+pm25+'</strong> μg</div></div></div>'
    +'</div>'
    +'<div class="section-label" style="padding-left:0">📦 设备清单 （'+products.length+' 类）</div>'
    +'<div style="display:flex;flex-direction:column;gap:6px">'
    +products.map(p=>
      '<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--soft);border-radius:8px;border:1px solid var(--border)">'
      +'<div style="font-size:22px">'+(p.icon||"📦")+'</div>'
      +'<div style="flex:1"><div style="font-size:13px;font-weight:600">'+p.name+(p.is_iot?' <span class="product-iot">IoT</span>':"")+'</div>'
      +'<div style="font-size:11px;color:var(--tx3);margin-top:2px">'+(p.reason||"")+'</div></div>'
      +'<div style="font-size:14px;font-weight:700;color:var(--accent2)">×'+p.quantity+'</div>'
      +'</div>'
    ).join("")+'</div>'
    +'<button style="width:100%;margin-top:14px;padding:10px;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#2DD4A8,#5EEBC0);color:#0A1A14" onclick="exportRoomDevices(\\''+id+'\\')">📋 导出此房间设备清单</button>';
  document.getElementById("rmBody").innerHTML=body;
  document.getElementById("roomModal").classList.add("show");
};
window.closeRoomModal=function(){
  document.getElementById("roomModal").classList.remove("show");
};
document.getElementById("roomModal").addEventListener("click",e=>{
  if(e.target.id==="roomModal")closeRoomModal();
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape")closeRoomModal();
});

// ── Export Room Devices ──
window.exportRoomDevices=function(roomId){
  var room=ROOMS.find(r=>r.id===roomId);
  if(!room){toast("未找到房间");return;}
  var products=JSON.parse(room.products_json||"[]");
  if(!products.length){toast("该房间暂无设备数据");return;}
  var csv="\\uFEFF设备名称,数量,类别,IoT设备,用途\\n";
  products.forEach(function(p){
    csv+='"'+p.name+'",'+p.quantity+',"'+(p.category||"")+'","'+(p.is_iot?"是":"否")+'","'+(p.reason||"")+'"\\n';
  });
  var blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=room.name+"-设备清单.csv";
  a.click();
  URL.revokeObjectURL(a.href);
  toast(room.name+" 设备清单已导出","success");
};

// ── Export All Devices ──
window.exportDeviceList=function(){
  if(!ROOMS.length){toast("暂无房间数据可导出");return;}
  var spaceName=document.getElementById("spaceName").value.trim()||"办公空间";
  var csv="\\uFEFF房间名称,房间类型,面积(㎡),设备名称,数量,类别,IoT设备,用途\\n";
  ROOMS.forEach(function(r){
    var products=JSON.parse(r.products_json||"[]");
    if(!products.length){
      csv+='"'+r.name+'","'+r.room_type+'",'+r.area+',"—",0,"—","—","—"\\n';
    }else{
      products.forEach(function(p){
        csv+='"'+r.name+'","'+r.room_type+'",'+r.area+',"'+p.name+'",'+p.quantity+',"'+(p.category||"")+'","'+(p.is_iot?"是":"否")+'","'+(p.reason||"")+ '"\\n';
      });
    }
  });
  var blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=spaceName+"-设备清单.csv";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("设备清单已导出为 CSV 文件","success");
};

// ── Generate Layout ──
window.generateLayout=async function(){
  const area=Number(document.getElementById("totalArea").value);
  if(!area||area<10){toast("请输入有效面积（≥10㎡）");return;}
  toast("正在生成 3D 布局...");

  if(TOKEN && SPACE_ID){
    try{
      const r=await fetch(API+"/api/iot/spaces/"+SPACE_ID+"/auto-layout",{
        method:"POST",headers:{"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"}
      });
      const d=await r.json();
      if(d.rooms){
        ROOMS=d.rooms.map(r=>({
          id:r.room_id,name:r.room_name,room_type:r.room_type||r.recommendations?.room_type,
          area:r.area||r.recommendations?.area,
          position_x:r.position?.x||0,position_y:r.position?.y||0,
          width:r.position?.w||Math.sqrt(r.area),depth:r.position?.d||Math.sqrt(r.area),
          height:2.8,products_json:JSON.stringify(r.recommendations?.products||[])
        }));
        renderRoomList();build3DScene();
        toast("布局生成完成！共 "+ROOMS.length+" 个房间");return;
      }
    }catch(e){console.warn("API fallback to local",e);}
  }
  ROOMS=generateLocalLayout(area);
  renderRoomList();build3DScene();
  toast("布局生成完成！共 "+ROOMS.length+" 个房间");
};

function generateLocalLayout(totalArea){
  const rooms=[];
  const recArea=Math.max(8,totalArea*0.05);
  const meetCount=totalArea>=200?2:1;
  const meetArea=totalArea>=200?totalArea*0.1:Math.max(12,totalArea*0.12);
  const pantryArea=Math.max(6,totalArea*0.04);
  const restArea=Math.max(4,totalArea*0.03);
  const serverArea=totalArea>=150?Math.max(8,totalArea*0.04):0;
  const storageArea=totalArea>=100?Math.max(6,totalArea*0.03):0;
  let alloc=recArea+meetArea*meetCount+pantryArea+restArea+serverArea+storageArea;
  const officeArea=totalArea-alloc;
  const bossArea=Math.min(25,officeArea*0.15);
  const openArea=officeArea-bossArea;

  let x=0,y=0,maxD=0;
  const wrapW=Math.sqrt(totalArea)*1.4;
  function add(name,type,area){
    const w=Math.round(Math.sqrt(area*1.3)*10)/10;
    const d=Math.round(area/w*10)/10;
    if(x+w>wrapW){x=0;y+=maxD+0.3;maxD=0}
    rooms.push({id:"r"+Math.random().toString(36).slice(2,8),name,room_type:type,area:Math.round(area*10)/10,position_x:x,position_y:y,width:w,depth:d,height:2.8,products_json:"[]"});
    x+=w+0.2;maxD=Math.max(maxD,d);
  }
  add("前台/接待区","reception",recArea);
  add("总经理办公室","office",bossArea);
  add("开放办公区","open_area",openArea);
  for(let i=0;i<meetCount;i++) add(meetCount>1?"会议室"+(i+1):"会议室","meeting",meetArea);
  add("茶水间","pantry",pantryArea);
  add("卫生间","restroom",restArea);
  if(serverArea) add("机房","server_room",serverArea);
  if(storageArea) add("储物间","storage",storageArea);
  rooms.forEach(r=>{r.products_json=JSON.stringify(localRecommend(r.room_type,r.area))});
  return rooms;
}

function localRecommend(type,area){
  const RULES={
    office:[{icon:"🪑",name:"行政办公桌",qty:a=>Math.max(1,Math.floor(a/6)),cat:"furniture",reason:"每 6㎡ 配一个工位"},
      {icon:"💺",name:"人体工学椅",qty:a=>Math.max(1,Math.floor(a/6)),cat:"furniture",reason:"每个工位配一把椅子"},
      {icon:"🌡️",name:"温湿度传感器",qty:1,cat:"iot_sensor",iot:true,reason:"监控办公区温湿度"},
      {icon:"📡",name:"人体感应传感器",qty:1,cat:"iot_sensor",iot:true,reason:"智能节能"},
      {icon:"💡",name:"智能灯控面板",qty:a=>Math.max(1,Math.ceil(a/15)),cat:"iot_control",iot:true,reason:"智能照明"}],
    meeting:[{icon:"🪵",name:"会议桌",qty:1,cat:"furniture",reason:"会议室标配"},
      {icon:"🪑",name:"会议椅",qty:a=>Math.max(4,Math.floor(a/2.5)),cat:"furniture",reason:"按面积配座椅"},
      {icon:"📺",name:"会议大屏",qty:1,cat:"equipment",reason:"会议演示必备"},
      {icon:"📡",name:"人体感应",qty:1,cat:"iot_sensor",iot:true,reason:"检测占用状态"},
      {icon:"💡",name:"灯控面板",qty:1,cat:"iot_control",iot:true,reason:"会议模式灯光"}],
    reception:[{icon:"🛋️",name:"接待沙发",qty:a=>Math.max(1,Math.floor(a/10)),cat:"furniture",reason:"接待区沙发"},
      {icon:"📷",name:"智能摄像头",qty:1,cat:"iot_sensor",iot:true,reason:"门禁监控"},
      {icon:"🔐",name:"智能门锁",qty:1,cat:"iot_control",iot:true,reason:"门禁管理"}],
    server_room:[{icon:"🌡️",name:"温湿度传感器",qty:2,cat:"iot_sensor",iot:true,reason:"双传感冗余"},
      {icon:"📷",name:"摄像头",qty:1,cat:"iot_sensor",iot:true,reason:"安全监控"},
      {icon:"🔐",name:"智能门锁",qty:1,cat:"iot_control",iot:true,reason:"门禁"},
      {icon:"📶",name:"路由器",qty:1,cat:"network",iot:true,reason:"网络核心"}],
    open_area:[{icon:"🪑",name:"办公桌",qty:a=>Math.max(2,Math.floor(a/5)),cat:"furniture",reason:"每 5㎡ 一工位"},
      {icon:"💺",name:"椅子",qty:a=>Math.max(2,Math.floor(a/5)),cat:"furniture",reason:"配椅"},
      {icon:"💡",name:"灯控面板",qty:a=>Math.max(1,Math.ceil(a/12)),cat:"iot_control",iot:true,reason:"密集照明"},
      {icon:"📡",name:"无线AP",qty:a=>Math.max(1,Math.ceil(a/40)),cat:"network",iot:true,reason:"无线覆盖"}],
    pantry:[{icon:"🌡️",name:"温湿度传感器",qty:1,cat:"iot_sensor",iot:true,reason:"环境监控"},
      {icon:"💡",name:"灯控面板",qty:1,cat:"iot_control",iot:true,reason:"灯控"}],
    restroom:[{icon:"📡",name:"人体感应",qty:1,cat:"iot_sensor",iot:true,reason:"智能照明"},{icon:"💡",name:"灯控",qty:1,cat:"iot_control",iot:true,reason:"感应灯"}],
    storage:[{icon:"🗄️",name:"文件柜",qty:2,cat:"furniture",reason:"存储"},{icon:"🔐",name:"门锁",qty:1,cat:"iot_control",iot:true,reason:"库房门禁"}]
  };
  const rules=RULES[type]||RULES.office;
  return rules.map(r=>({icon:r.icon,name:r.name,quantity:typeof r.qty==="function"?r.qty(area):r.qty,category:r.cat,is_iot:!!r.iot,reason:r.reason,price_range:""}));
}

// ── Add Room Dialog ──
window.showAddRoom=function(){
  var existing=document.getElementById("add-room-modal");
  if(existing)existing.remove();
  var overlay=document.createElement("div");
  overlay.id="add-room-modal";
  overlay.style.cssText="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,0.65);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.addEventListener("click",function(e){if(e.target===overlay)overlay.remove()});
  overlay.innerHTML=\`<div style="width:420px;max-width:96vw;background:linear-gradient(180deg,rgba(10,26,20,.98),rgba(6,18,16,.98));border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);">
    <div style="padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <h3 style="font-size:15px;font-weight:700;margin:0">🏠 添加房间</h3>
      <button onclick="document.getElementById('add-room-modal').remove()" style="width:28px;height:28px;border-radius:50%;background:var(--soft);border:none;color:var(--tx2);font-size:18px;cursor:pointer">×</button>
    </div>
    <div style="padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div><label style="font-size:10px;font-weight:600;color:var(--tx2);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.8px">房间名称</label><input class="form-input" id="addroom-name" value="新房间" placeholder="输入房间名称"></div>
      <div><label style="font-size:10px;font-weight:600;color:var(--tx2);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.8px">房间类型</label>
        <select class="form-input" id="addroom-type">
          <option value="office">🏢 独立办公室</option>
          <option value="open_area">🏗️ 开放办公区</option>
          <option value="meeting">📋 会议室</option>
          <option value="reception">🛋️ 接待区</option>
          <option value="pantry">☕ 茶水间</option>
          <option value="server_room">🖥️ 机房</option>
          <option value="storage">📦 储物间</option>
          <option value="restroom">🚻 卫生间</option>
          <option value="lobby">🏛️ 大堂</option>
          <option value="private_room">🍽️ 包厢</option>
          <option value="kitchen">🍳 厨房</option>
          <option value="dining_hall">🍜 餐厅</option>
          <option value="lounge">🛋️ 休息室</option>
          <option value="classroom">📖 教室</option>
          <option value="showroom">🖼️ 展厅</option>
          <option value="bedroom">🛏️ 客房</option>
          <option value="warehouse">🏭 仓库</option>
        </select>
      </div>
      <div><label style="font-size:10px;font-weight:600;color:var(--tx2);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.8px">面积 (㎡)</label><input class="form-input" id="addroom-area" type="number" value="15" min="2" max="500"></div>
    </div>
    <div style="padding:14px 22px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border);background:rgba(0,0,0,.2)">
      <button class="btn btn-ghost" onclick="document.getElementById('add-room-modal').remove()">取消</button>
      <button class="btn btn-primary" onclick="doAddRoom()">添加房间</button>
    </div>
  </div>\`;
  document.body.appendChild(overlay);
  setTimeout(function(){document.getElementById("addroom-name").focus()},50);
};

window.doAddRoom=function(){
  const name=document.getElementById("addroom-name").value.trim()||"新房间";
  const type=document.getElementById("addroom-type").value||"office";
  const area=Number(document.getElementById("addroom-area").value)||15;
  const w=Math.sqrt(area*1.2),d=area/w;
  const maxX=Math.max(0,...ROOMS.map(r=>r.position_x+(r.width||4)));
  const room={id:"r"+Math.random().toString(36).slice(2,8),name,room_type:type,area,position_x:maxX+1,position_y:0,width:Math.round(w*10)/10,depth:Math.round(d*10)/10,height:2.8,products_json:JSON.stringify(localRecommend(type,area))};
  ROOMS.push(room);
  var modal=document.getElementById("add-room-modal");if(modal)modal.remove();
  renderRoomList();build3DScene();toast("已添加: "+name);
};

// ── Photo Upload ──
window.handlePhotoUpload=function(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=function(e){
    const img=document.getElementById("photoPreview");
    img.src=e.target.result;img.style.display="block";
    toast("照片已上传");
  };
  reader.readAsDataURL(file);
};

// ── Load space from backend ──
async function loadSpaceFromBackend(spaceId){
  if(!spaceId)return false;
  try{
    var hdrs={};
    if(TOKEN) hdrs["Authorization"]="Bearer "+TOKEN;
    const r=await fetch(API+"/api/iot/spaces/"+spaceId,{headers:hdrs});
    if(!r.ok)return false;
    const data=await r.json();
    if(data.total_area){document.getElementById("totalArea").value=data.total_area}
    if(data.name){document.getElementById("spaceName").value=data.name;updateHeaderTitle();}
    SPACE_ID=spaceId;
    if(data.rooms&&data.rooms.length>0){
      ROOMS=data.rooms.map(function(rm){
        return{
          id:rm.id,name:rm.name,room_type:rm.room_type,
          area:rm.area,position_x:rm.position_x||0,position_y:rm.position_y||0,
          width:rm.width||Math.sqrt(rm.area),depth:rm.depth||Math.sqrt(rm.area),
          height:rm.height||2.8,floor:rm.floor||1,products_json:rm.products_json||"[]"
        };
      });
      renderRoomList();build3DScene();
      toast("已加载空间「"+data.name+"」，共 "+ROOMS.length+" 个房间");
      return true;
    }
    return false;
  }catch(e){console.warn("Failed to load space",e);return false;}
}

async function loadLatestSpace(){
  if(!TOKEN)return false;
  try{
    const r=await fetch(API+"/api/iot/spaces",{headers:{"Authorization":"Bearer "+TOKEN}});
    if(!r.ok)return false;
    const data=await r.json();
    if(data.spaces&&data.spaces.length>0){return await loadSpaceFromBackend(data.spaces[0].id)}
    return false;
  }catch(e){return false;}
}

// ── AI Chat ──
var aiChatOpen=false;
window.toggleAiChat=function(){
  aiChatOpen=!aiChatOpen;
  document.getElementById("aiChatPanel").classList.toggle("open",aiChatOpen);
  document.getElementById("aiChatToggle").style.display=aiChatOpen?"none":"flex";
  if(aiChatOpen){setTimeout(function(){document.getElementById("aiChatInput").focus()},100);}
};
window.aiHintClick=function(el){
  document.getElementById("aiChatInput").value=el.textContent;
  sendAiChat();
};
function addAiMsg(role,html){
  var box=document.getElementById("aiChatMessages");
  var d=document.createElement("div");d.className="ai-msg "+role;
  d.innerHTML='<div class="ai-msg-avatar">'+(role==="user"?"👤":"🤖")+'</div><div class="ai-msg-bubble">'+html+'</div>';
  box.appendChild(d);box.scrollTop=box.scrollHeight;
  return d;
}
function addAiThinking(){
  var d=addAiMsg("assistant",'<div class="ai-msg-thinking"><span></span><span></span><span></span></div>');
  d.id="ai-thinking";return d;
}
window.sendAiChat=async function(){
  var input=document.getElementById("aiChatInput");
  var msg=input.value.trim();if(!msg)return;
  input.value="";
  document.getElementById("aiChatHints").style.display="none";
  addAiMsg("user",msg.replace(/</g,"&lt;"));
  var thinking=addAiThinking();
  document.getElementById("aiChatSend").disabled=true;

  var currentRooms=ROOMS.map(function(r){return{name:r.name,room_type:r.room_type,area:r.area}});
  var totalArea=Number(document.getElementById("totalArea").value)||200;
  var prompt='你是一个办公空间布局 AI 助手。当前空间总面积 '+totalArea+'㎡，现有房间如下:\\n'+JSON.stringify(currentRooms)+'\\n\\n用户要求：'+msg+'\\n\\n请根据用户要求，返回调整后的完整房间列表（JSON 数组），每个房间有 name, room_type, area 字段。room_type 只能从 [reception, meeting, open_area, office, pantry, restroom, server_room, storage] 中选择。确保所有房间面积之和不超过总面积。\\n只返回 JSON 数组，不要其他解释文字。';

  try{
    var headers={"Content-Type":"application/json"};
    if(TOKEN)headers["Authorization"]="Bearer "+TOKEN;
    var r=await fetch(API+"/api/iot/ai-chat-layout",{
      method:"POST",headers:headers,
      body:JSON.stringify({message:prompt,totalArea:totalArea,currentRooms:currentRooms})
    });
    thinking.remove();
    if(!r.ok){
      var errText=await r.text().catch(function(){return "请求失败"});
      addAiMsg("assistant","抱歉，请求失败了："+errText.replace(/</g,"&lt;").substring(0,200));
      document.getElementById("aiChatSend").disabled=false;return;
    }
    var data=await r.json();
    if(data.rooms&&data.rooms.length>0){
      var newRooms=data.rooms;
      var desc=data.explanation||("已调整为 "+newRooms.length+" 个房间");
      addAiMsg("assistant",desc.replace(/</g,"&lt;")+'<br><span style="font-size:11px;color:var(--tx3);margin-top:6px;display:block">✅ 布局已更新，共 '+newRooms.length+' 个房间</span>');

      var x=0,y=0,maxD=0;
      var wrapW=Math.sqrt(totalArea)*1.4;
      ROOMS=newRooms.map(function(nr,i){
        var a=nr.area||15;var w=Math.sqrt(a)*1.2;var d=a/w;
        if(x+w>wrapW){x=0;y+=maxD+0.5;maxD=0;}
        var room={id:"ai-"+Date.now()+"-"+i,name:nr.name,room_type:nr.room_type,area:a,position_x:x,position_y:y,width:w,depth:d,height:2.8,products_json:JSON.stringify(generateRoomProducts(nr.room_type,a))};
        x+=w+0.5;if(d>maxD)maxD=d;
        return room;
      });
      renderRoomList();build3DScene();
      toast("AI 已调整布局："+ROOMS.length+" 个房间","success");
    } else {
      addAiMsg("assistant",data.explanation||"抱歉，我没能理解你的需求。请尝试更具体地描述。");
    }
  }catch(e){
    thinking.remove();
    addAiMsg("assistant","请求出错："+String(e.message||e).replace(/</g,"&lt;").substring(0,200));
  }
  document.getElementById("aiChatSend").disabled=false;
};

function generateRoomProducts(type,area){
  var products=[];
  var typeProducts={
    "office":[{name:"办公桌",category:"家具",is_iot:false},{name:"人体工学椅",category:"家具",is_iot:false},{name:"温湿度传感器",category:"传感器",is_iot:true},{name:"灯控面板",category:"智能控制",is_iot:true}],
    "open_area":[{name:"办公桌",category:"家具",is_iot:false},{name:"椅子",category:"家具",is_iot:false},{name:"灯控面板",category:"智能控制",is_iot:true},{name:"无线AP",category:"网络",is_iot:true}],
    "meeting":[{name:"会议桌",category:"家具",is_iot:false},{name:"会议椅",category:"家具",is_iot:false},{name:"会议大屏",category:"设备",is_iot:true},{name:"人体感应器",category:"传感器",is_iot:true}],
    "reception":[{name:"前台桌",category:"家具",is_iot:false},{name:"访客沙发",category:"家具",is_iot:false},{name:"智能门禁",category:"安防",is_iot:true}],
    "pantry":[{name:"饮水机",category:"设备",is_iot:false},{name:"微波炉",category:"设备",is_iot:false},{name:"烟雾传感器",category:"安防",is_iot:true}],
    "restroom":[{name:"卫浴设施",category:"设备",is_iot:false},{name:"人体感应器",category:"传感器",is_iot:true},{name:"灯控",category:"智能控制",is_iot:true}],
    "server_room":[{name:"机柜",category:"设备",is_iot:false},{name:"温湿度传感器",category:"传感器",is_iot:true},{name:"UPS",category:"设备",is_iot:true}],
    "storage":[{name:"储物架",category:"家具",is_iot:false},{name:"门禁",category:"安防",is_iot:true}]
  };
  var list=typeProducts[type]||typeProducts["office"];
  list.forEach(function(p){
    var qty=Math.max(1,Math.round(area/(p.category==="家具"?8:20)));
    products.push({name:p.name,quantity:qty,category:p.category,is_iot:p.is_iot,reason:p.name+"用于"+type+"场景"});
  });
  return products;
}

// ── Init ──
init3D();
updateHeaderTitle();
(async function(){
  var loaded=false;
  if(SPACE_ID){
    loaded=await loadSpaceFromBackend(SPACE_ID);
  }
  if(!loaded && TOKEN){
    loaded=await loadLatestSpace();
  }
  if(!loaded){
    var area=Number(document.getElementById("totalArea").value)||200;
    ROOMS=generateLocalLayout(area);
    renderRoomList();build3DScene();
    toast("已自动生成 "+ROOMS.length+" 个房间的 3D 布局");
  }
})();

})();
<\/script>
</body>
</html>`;
}
