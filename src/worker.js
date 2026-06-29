
const API_HOST = "https://api005.dnshe.com";
const VALID_DAYS = 365;        // 有效期固定 365 天
const RENEW_BEFORE_DAYS = 180; // 只有剩余天数 <= 180 天才续期
const DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 支持手动触发: /run
    if (url.pathname === "/run") {
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (msg) => {
              console.log(msg);
              // 确保发送的是 UTF-8 字符串
              controller.enqueue(`data: ${JSON.stringify({ msg, time: new Date().toISOString() })}\n\n`);
            };

            try {
              if (!env.API_KEY || !env.API_SECRET) {
                send("❌ 错误：请在 Workers 环境变量中配置 API_KEY 和 API_SECRET");
                controller.close();
                return;
              }

              send("🚀 开始检查 DNSHE 域名...");

              // 1. 获取所有活跃域名
              const domains = await listActiveDomains(env, send);
              
              if (!domains || domains.length === 0) {
                send("✅ 检查完成：没有需要处理的活跃域名，或所有域名剩余有效期均大于 " + RENEW_BEFORE_DAYS + " 天");
                controller.close();
                return;
              }

              send(`📋 找到 ${domains.length} 个符合续期条件的域名（剩余有效期 <= ${RENEW_BEFORE_DAYS} 天）`);

              // 2. 逐个续期
              for (const domain of domains) {
                await renewDomain(domain, env, send);
                // 避免频率限制，每次请求间隔 1.5 秒
                await sleep(1500);
              }

              send("🎉 所有任务处理完毕");
            } catch (e) {
              send(`❌ 发生未捕获错误: ${e.message}`);
              console.error(e);
            } finally {
              controller.close();
            }
          }
        }),
        {
          headers: {
            // 关键修复：明确指定 UTF-8 编码，防止浏览器或客户端以 GBK 解析
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          }
        }
      );
    }

    // 默认首页 - 修复乱码：明确指定 UTF-8 编码
    return new Response(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DNSHE 自动续期服务</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.6; background-color: #f5f7fa; color: #333; }
          .container { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
          h1 { color: #2c3e50; margin-top: 0; }
          a { display: inline-block; background-color: #3498db; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; transition: background 0.3s; }
          a:hover { background-color: #2980b9; }
          .status { color: #27ae60; font-weight: bold; }
          .footer { margin-top: 20px; font-size: 0.9em; color: #7f8c8d; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>DNSHE 自动续期服务</h1>
          <p>状态: <span class="status">运行中</span></p>
          <p>点击下方按钮手动执行一次续期检查：</p>
          <p><a href="/run">开始执行续期检查</a></p>
          <div class="footer">
            <p>提示：请确保已在 Cloudflare Workers 环境变量中正确配置 API_KEY 和 API_SECRET。</p>
          </div>
        </div>
      </body>
      </html>
    `, { 
      headers: { 
        "Content-Type": "text/html; charset=utf-8" 
      } 
    });
  },

  // 支持定时触发 (需在 Cloudflare 后台配置 Cron Trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoRenew(env));
  }
};

// 后台静默执行函数（用于定时任务）
async function runAutoRenew(env) {
  const log = (msg) => console.log(`[Scheduled] ${msg}`);
  
  if (!env.API_KEY || !env.API_SECRET) {
    log("❌ 缺少 API 密钥");
    return;
  }

  const domains = await listActiveDomains(env, log);
  if (!domains || domains.length === 0) {
    log("✅ 无需续期");
    return;
  }

  log(`📋 发现 ${domains.length} 个需续期域名`);
  for (const domain of domains) {
    await renewDomain(domain, env, log);
    await sleep(1500);
  }
  log("🎉 定时任务完成");
}

// 获取活跃且需要续期的域名列表
async function listActiveDomains(env, send) {
  // 构造 API URL: 获取所有 active 状态的域名，按过期时间升序排列（快过期的在前）
  const params = new URLSearchParams({
    m: 'domain_hub',
    endpoint: 'subdomains',
    action: 'list',
    status: 'active',       // 只获取活跃域名
    sort_by: 'expires_at',  // 按过期时间排序
    sort_dir: 'asc',        // 升序，最早过期的在前面
    per_page: '500',        // 最大每页数量
    fields: 'id,full_domain,updated_at,expires_at,status' // 明确指定字段
  });

  const url = `${API_HOST}/index.php?${params.toString()}`;
  
  send(`🔍 正在请求域名列表...`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-API-Key': env.API_KEY,
      'X-API-Secret': env.API_SECRET,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API 请求失败: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  
  // DNSHE API V2.0 返回结构检查
  if (!data.success || !data.subdomains) {
    send("⚠️ API 返回数据格式异常或无数据");
    console.log("API Response:", JSON.stringify(data));
    return [];
  }

  const now = new Date();
  const candidates = [];

  for (const item of data.subdomains) {
    // 计算剩余天数
    let expireDate;
    
    // 优先使用 expires_at，如果不存在则使用 updated_at + 365天估算
    if (item.expires_at) {
      expireDate = new Date(item.expires_at);
    } else if (item.updated_at) {
      expireDate = new Date(new Date(item.updated_at).getTime() + VALID_DAYS * DAY_MS);
    } else {
      send(`⚠️ 域名 ${item.full_domain} 缺少时间信息，跳过`);
      continue;
    }

    if (isNaN(expireDate.getTime())) {
      send(`⚠️ 域名 ${item.full_domain} 时间格式错误，跳过`);
      continue;
    }

    const remainingMs = expireDate - now;
    const remainingDays = Math.ceil(remainingMs / DAY_MS);

    send(`📝 域名: ${item.full_domain} | 过期时间: ${expireDate.toLocaleString()} | 剩余: ${remainingDays} 天`);

    // 判断是否需要续期：剩余天数 <= 阈值
    if (remainingDays <= RENEW_BEFORE_DAYS) {
      candidates.push({
        id: item.id,
        full_domain: item.full_domain,
        remaining_days: remainingDays
      });
    } else {
      send(`✅ 域名 ${item.full_domain} 剩余 ${remainingDays} 天，无需续期`);
    }
  }

  return candidates;
}

// 执行单个域名续期
async function renewDomain(domain, env, send) {
  send(`🔄 正在续期: ${domain.full_domain} (ID: ${domain.id})...`);

  const params = new URLSearchParams({
    m: 'domain_hub',
    endpoint: 'subdomains',
    action: 'renew',
    subdomain_id: domain.id
  });

  const url = `${API_HOST}/index.php?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'POST', // 续期通常是 POST
      headers: {
        'X-API-Key': env.API_KEY,
        'X-API-Secret': env.API_SECRET,
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (response.ok && result.success) {
      send(`✅ 成功: ${domain.full_domain} 已续期`);
    } else {
      send(`❌ 失败: ${domain.full_domain} - ${result.message || '未知错误'}`);
    }
  } catch (e) {
    send(`❌ 网络错误: ${domain.full_domain} - ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


