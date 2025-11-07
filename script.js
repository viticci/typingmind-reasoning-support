(() => {
  console.log("🧠 Reasoning Continuity Extension initializing…");

  /**************************************************************
   * 1️⃣  Configuration
   **************************************************************/
  const ENDPOINTS_WITH_REASONING = [
    "https://openrouter.ai/api/v1/chat/completions",
    "https://api.minimax.chat/v1/text/chatcompletion",
    "https://api.moonshot.ai/v1/chat/completions"
  ];

  // In-memory reasoning cache
  const reasoningCache = new Map();

  const makeCompoundKey = (msg) =>
    JSON.stringify({
      response_id: msg.response_id || null,
      content: msg.content?.trim() || "",
      tool_calls: msg.tool_calls?.map((t) => t.function?.name || t.name) || [],
    });

  /**************************************************************
   * 2️⃣  Capture reasoning_details from BOTH streaming & non-streaming responses
   **************************************************************/
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const [url, options] = args;
    if (!ENDPOINTS_WITH_REASONING.some((ep) => url.includes(ep))) {
      return origFetch(...args);
    }

    const resp = await origFetch(...args);

    // --- Case A: Streaming response (event-stream / chunked)
    if (resp.headers.get("content-type")?.includes("event-stream")) {
      const reader = resp.body.getReader();
      const stream = new ReadableStream({
        start(controller) {
          const decoder = new TextDecoder("utf-8");
          const encoder = new TextEncoder();
          let buffer = "";
          let currentId = null;
          let currentModel = null;
          let collectedReasoning = [];

          const read = async () => {
            const { done, value } = await reader.read();
            if (done) {
              // Save reasoning at the end
              if (currentId && collectedReasoning.length) {
                reasoningCache.set(currentId, {
                  model: currentModel,
                  reasoning_details: collectedReasoning,
                  structuralKey: makeCompoundKey({
                    response_id: currentId,
                    content: "",
                    tool_calls: [],
                  }),
                });
                console.log(
                  `💾 Cached (stream) reasoning for ${currentId}`,
                  collectedReasoning.length
                );
              }
              controller.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              if (!part.trim().startsWith("data:")) continue;
              const json = part.slice(5).trim();
              if (json === "[DONE]") continue;

              try {
                const data = JSON.parse(json);
                const choice = data?.choices?.[0];
                const delta = choice?.delta || {};
                currentId = data?.id || currentId;
                currentModel = data?.model || currentModel;

                if (delta?.reasoning_details?.length) {
                  collectedReasoning.push(...delta.reasoning_details);
                }
              } catch (err) {
                console.warn("Stream parse error:", err);
              }

              controller.enqueue(encoder.encode(part + "\n\n"));
            }

            read();
          };
          read();
        },
      });
      return new Response(stream, { headers: resp.headers });
    }

    // --- Case B: Non-streaming response (JSON body)
    try {
      const clone = resp.clone();
      const json = await clone.json();

      if (json?.choices?.[0]?.message?.reasoning_details?.length) {
        const id = json.id;
        const model = json.model;
        const reasoning_details = json.choices[0].message.reasoning_details;

        reasoningCache.set(id, {
          model,
          reasoning_details,
          structuralKey: makeCompoundKey({
            response_id: id,
            content: json.choices[0].message.content || "",
            tool_calls: json.choices[0].message.tool_calls || [],
          }),
        });

        console.log(
          `💾 Cached (non-stream) reasoning for ${id}`,
          reasoning_details.length
        );
      }
    } catch (err) {
      // It's not JSON or doesn't include reasoning; ignore
    }

    return resp;
  };

  /**************************************************************
   * 3️⃣  Inject reasoning_details into next outgoing request
   **************************************************************/
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const parsed = typeof body === "string" ? JSON.parse(body) : null;
      if (parsed?.messages && ENDPOINTS_WITH_REASONING.some((ep) => this._url?.includes(ep))) {
        const prevAssistant = [...parsed.messages].reverse().find((m) => m.role === "assistant");
        const model = parsed.model;

        if (prevAssistant && model) {
          const prevId = prevAssistant.response_id;
          const compoundKey = makeCompoundKey(prevAssistant);

          // Primary match: exact response id
          let cached = prevId ? reasoningCache.get(prevId) : null;

          // Fallback match: same id + identical structure
          if (!cached) {
            for (const entry of reasoningCache.values()) {
              if (entry.model === model && entry.structuralKey === compoundKey) {
                cached = entry;
                break;
              }
            }
          }

          if (cached?.reasoning_details?.length) {
            prevAssistant.reasoning_details = cached.reasoning_details;
            console.log(
              `🧩 Injected reasoning (${cached.reasoning_details.length} items) for model ${model}`
            );
          }
        }

        body = JSON.stringify(parsed);
      }
    } catch (err) {
      console.warn("Reasoning inject error:", err);
    }
    return origSend.call(this, body);
  };

  // Remember request URL
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this._url = args[1];
    return origOpen.apply(this, args);
  };

  /**************************************************************
   * 4️⃣  Done
   **************************************************************/
  console.log("✅ Reasoning Continuity Extension (stream + non-stream) active");
})();
