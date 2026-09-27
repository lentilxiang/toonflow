const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const apiUrl = "https://api.agnes-ai.cn/v1";
const version = "2.0.0";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agnes 响应格式错误");
  return value as Record<string, unknown>;
}

function apiKey(context: ProviderContext): string {
  const key = typeof context.config.apiKey === "string"
    ? context.config.apiKey.trim().replace(/^Bearer\s+/i, "").trim()
    : "";
  if (!key) throw new Error("请填写 Agnes API Key");
  return key;
}

/** 素材转 URL；本地文件转 base64 data URL，已是 http(s) 地址直接透传。 */
function mediaUrl(input: MediaInput): string {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function videoAsset(url: unknown): MediaAsset[] {
  if (typeof url !== "string" || !url.trim()) throw new Error("Agnes 未返回视频地址");
  const value = url.trim();
  if (!/^https?:\/\//i.test(value)) throw new Error("Agnes 返回的视频地址无效");
  return [{ mediaType: "video", type: "url", url: value }];
}

function imageAsset(result: Record<string, unknown>): MediaAsset[] {
  // ACT: 文生图 URL 输出走 data[0].url，Base64 输出走 data[0].b64_json。
  const items = Array.isArray(result.data) ? result.data : [];
  const first = items[0];
  const item = first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>) : {};
  if (typeof item.url === "string" && item.url.trim()) {
    const url = item.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("Agnes 返回的图片地址无效");
    return [{ mediaType: "image", type: "url", url }];
  }
  if (typeof item.b64_json === "string" && item.b64_json.trim()) {
    return [{ mediaType: "image", type: "base64", mimeType: "image/png", data: item.b64_json }];
  }
  throw new Error("Agnes 未返回图片结果");
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// ACT: 免费 key 实测 RPM 极低——连续提交第 3 个视频任务即 429，触发后冷却约 30s 才恢复。
// 因此提交侧做两级保护：① 提交间隔节流（≥35s 留余量越过 30s 冷却窗口）；② 429 指数退避重试。
// 冷却状态放在模块作用域，跨多次 generateVideo 调用共享，避免同进程内连环撞 429。
const videoSubmitThrottleMs = 35_000;
const videoCooldownMs = 35_000;
const videoMaxRetries = 3;
let lastVideoSubmitAt = 0;

async function throttleVideoSubmit(signal: AbortSignal) {
  const elapsed = Date.now() - lastVideoSubmitAt;
  const remaining = videoSubmitThrottleMs - elapsed;
  if (remaining > 0) await wait(signal, remaining);
  lastVideoSubmitAt = Date.now();
}

/** 提交视频任务；429 时按 35s→70s→105s 退避重试，越过冷却窗口。 */
async function submitVideoTask(
  context: ProviderContext,
  signal: AbortSignal,
  key: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    await throttleVideoSubmit(signal);
    const response = await context.tool.fetch(`${apiUrl}/videos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    // ACT: 读一次 body 判服务端"忙"类错误（429 / video_queue_full / rate_limit / busy），统一指数退避。
    const bodyText = response.ok ? "" : await (async () => { try { return await response.clone().text(); } catch { return ""; } })();
    const busy = response.status === 429
      || /queue_full|rate_limit|busy|队列已满|请稍后/i.test(bodyText);
    if (busy) {
      if (attempt >= videoMaxRetries) {
        throw new Error(`Agnes 视频提交持续 ${response.status === 429 ? "429 限流" : "队列忙"}，已重试 ${videoMaxRetries} 次仍失败，请稍后再试`);
      }
      const backoff = videoCooldownMs * (attempt + 1);
      console.warn(`[Agnes] 视频提交撞 ${response.status === 429 ? "429" : "queue_full"}，退避 ${backoff}ms 后重试（第 ${attempt + 1}/${videoMaxRetries} 次）`);
      await wait(signal, backoff);
      continue;
    }
    if (!response.ok) throw new Error(`Agnes 提交视频任务失败（HTTP ${response.status}）`);
    return object(await response.json());
  }
}

export default {
  id: "agnes" as const,
  label: "Agnes",
  version,
  apiUrl,
  readme: "## Agnes AI 视频生成\n\nOpenAI Videos 兼容协议，支持文生视频、首尾帧与多模态参考。文档：https://wiki.agnes-ai.cn/\n\n> 注意：Agnes Video v2.0 已下线，请选用 2.5 / 2.5 Flash 系列。",
  rules,
  models: [
    {
      "id": "agnes-video-2.5-flash",
      "label": "Agnes Video 2.5 Flash",
      "type": "video",
      "mode": [
        "text",
        "startFrameOptional",
        [
          "imageReference:5",
          "audioReference:3"
        ]
      ],
      "audio": "optional",
      "durationResolutionMap": [
        {
          "duration": [
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12
          ],
          "resolution": [
            "720P"
          ]
        }
      ]
    },
    {
      "id": "agnes-image-2.5-flash",
      "label": "Agnes Image 2.5 Flash",
      "type": "image",
      "mode": [
        "text",
        "singleImage",
        "multiReference"
      ],
      "imageSizes": [
        "1K",
        "2K",
        "3K",
        "4K"
      ],
      "imageRatios": [
        "1:1",
        "3:4",
        "4:3",
        "16:9",
        "9:16",
        "2:3",
        "3:2",
        "21:9"
      ]
    }
  ],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const key = apiKey(this);
    // ACT: 图片生成同步返回，无需轮询；官方建议客户端超时 60–360s，这里取 5 分钟上限。
    const signal = AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const images = (request.images ?? []).map(mediaUrl).slice(0, 5);
    if ((request.images?.length ?? 0) > 5) throw new Error("Agnes Image 参考图最多 5 张");
    // ACT: 档位 size（1K/2K/3K/4K）配 8 种 ratio；不支持精确像素，自动标准化到最近档位。
    const size = (request.size ?? "2K").toUpperCase();
    const ratio = request.ratio ?? "1:1";
    // ACT: 输入参考图与输出格式必须嵌套在 extra_body 里，顶层放 response_format 会 400。
    const extraBody: Record<string, unknown> = { response_format: "url" };
    if (images.length) extraBody.image = images;

    const response = await this.tool.fetch(`${apiUrl}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        size,
        ratio,
        extra_body: extraBody,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Agnes 图片生成失败（HTTP ${response.status}）`);
    return imageAsset(object(await response.json()));
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const key = apiKey(this);
    // ACT: 单次生成最多等待 30 分钟。
    const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const images = (request.images ?? []).map(mediaUrl).slice(0, 5);
    const audios = (request.audios ?? []).map(mediaUrl).slice(0, 3);
    if ((request.images?.length ?? 0) > 5) throw new Error("Agnes 2.5 Flash 参考图最多 5 张");
    if ((request.audios?.length ?? 0) > 3) throw new Error("Agnes 2.5 Flash 音频参考最多 3 段");
    if (request.videos?.length) throw new Error("Agnes 2.5 Flash 不支持视频参考（videos）");
    const ratio = request.ratio ?? "16:9";
    // ACT: Flash 仅 720P，强制钉死，避免请求 1080P/1K/2K 被拒。
    const size = "720P";

    // ACT: 首尾帧走 keyframe，多参考走 reference，无素材走 text；三者互斥，与 Agnes 2.5 模式规则一致。
    let mode: "text" | "keyframe" | "reference";
    let firstFrame: string | undefined;
    let lastFrame: string | undefined;
    if (request.firstFrame || request.lastFrame || request.mode === "startFrameOptional" || request.mode === "endFrameOptional") {
      mode = "keyframe";
      firstFrame = request.firstFrame ? mediaUrl(request.firstFrame) : undefined;
      lastFrame = request.lastFrame ? mediaUrl(request.lastFrame) : undefined;
      if (!firstFrame && !lastFrame) throw new Error("首尾帧模式至少需要一张首帧或尾帧");
    } else if (images.length || audios.length) {
      mode = "reference";
    } else {
      mode = "text";
    }

    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      mode,
      seconds: String(Math.min(Math.max(request.duration ?? 5, 4), 12)),
      size,
      aspect_ratio: ratio,
      n: 1,
    };
    if (mode === "keyframe") {
      if (firstFrame) body.first_frame = firstFrame;
      if (lastFrame) body.last_frame = lastFrame;
    } else if (mode === "reference") {
      if (images.length) body.images = images;
      if (audios.length) body.audios = audios;
    }

    const submitResult = await submitVideoTask(this, signal, key, body);
    const videoId = submitResult.video_id ?? submitResult.id;
    if (typeof videoId !== "string" || !videoId.trim()) throw new Error("Agnes 未返回 video_id");

    // ACT: 查询带 model_name，适用于全部模式；推荐轮询间隔 1–2 秒。
    // 兜底：只要 url 有值（http/https）就立刻返回，不等 status 翻转——Agnes 可能 status 还是
    // queued/pending 但 url 已经生成，避免 30 分钟空转。同时把轮询日志透出到 media/debug 面板。
    let pollCount = 0;
    let consecutivePoll429 = 0; // 轮询阶段连续撞 429 计数，超限才抛，避免桌面端出视频失败
    const maxPoll429 = 10;       // 轮询 429 最多忍 10 次（约 2 分钟），超过才放弃
    while (true) {
      pollCount++;
      const queryResponse = await this.tool.fetch(`${apiUrl.slice(0, -3)}/agnesapi?video_id=${encodeURIComponent(videoId.trim())}&model_name=${encodeURIComponent(request.model)}`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal,
      });
      // ACT: 轮询阶段也可能撞 429（服务端忙）——不直接 throw，等 15s 再试，连续 10 次才放弃。
      // 避免桌面端出视频刚提交就失败（提交成功但轮询被 429 打回）。
      if (queryResponse.status === 429) {
        consecutivePoll429++;
        if (consecutivePoll429 > maxPoll429) {
          throw new Error(`Agnes 轮询持续 429，已重试 ${maxPoll429} 次仍失败，请稍后再试`);
        }
        console.warn(`[Agnes] 轮询撞 429（第 ${consecutivePoll429}/${maxPoll429} 次），15s 后再试 video_id=${videoId}`);
        await wait(signal, 15_000);
        continue;
      }
      consecutivePoll429 = 0; // 非 429 重置计数
      if (!queryResponse.ok) throw new Error(`Agnes 查询任务失败（HTTP ${queryResponse.status}）`);
      const task = object(await queryResponse.json());
      const status = String(task.status ?? task.state ?? "").toLowerCase();
      const urlValue = typeof task.url === "string" ? task.url.trim() : "";
      const progress = typeof task.progress === "number" ? task.progress : null;

      // ACT: 完成态判定——status 明确 completed/success/done/finished，或 url 已是 http(s) 地址。
      // 任一命中就立刻取 videoAsset 返回，不等 status 翻转，避免 30 分钟空转。
      const isDone = /completed|success|done|finished/i.test(status) || /^https?:\/\//i.test(urlValue);
      if (isDone && urlValue) {
        return videoAsset(urlValue);
      }
      // 失败态
      if (/failed|failure|error|cancelled|canceled/i.test(status)) {
        const error = object(task.error ?? {});
        throw new Error(typeof error.message === "string" ? error.message : `Agnes 视频生成失败（status=${status}）`);
      }
      // ACT: 每 5 次轮询（约 10s）打一次进度日志到终端，方便桌面端诊断 idle 卡点。
      if (pollCount % 5 === 0) {
        console.warn(`[Agnes] 视频轮询 #${pollCount}：status=${status || "(空)"} progress=${progress ?? "?"} video_id=${videoId}`);
      }
      await wait(signal, 2000);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
