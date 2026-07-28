"use strict";

const crypto = require("crypto");
const axios  = require("axios");
const http   = require("http");
const https  = require("https");
const db     = require("../data/database");

const PA_WEBHOOK_URL = process.env.PA_WEBHOOK_URL;
if (!PA_WEBHOOK_URL) {
    console.warn("⚠️ PA_WEBHOOK_URL is not configured. Forwarding is disabled.");
}

const httpAgent  = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const COMPLAINT_MIN_LENGTH = 10;
const COMPLAINT_MAX_LENGTH = 500;

const STATEMENT_RANGES = ["3M", "6M", "FULL"];

const actionMap = Object.freeze({
    USER_MESSAGE:     {type: "INPUT_PHONE",      state: ""                          },
    INPUT_PHONE:     { type: "INPUT_PHONE_READY",      state: ""                          },
    NEW_QUOTE:       { type: "PROMPT_ORDER_ENTRY",      state: "COLLECT_QUOTE"             },
    PRODUCTS:        { type: "CUSTOMER_CODE_READY",     state: "CUSTOMER_CODE"             },
    ADD_PRODUCT:     { type: "CUSTOMER_CODE_READY",     state: "ADDING_PRODUCT"            },
    ORDER_STATUS:    { type: "PROMPT_DOC_NO",           state: "FETCH_ORDER"               },
    DELIVERY_STATUS: { type: "PROMPT_DOC_NO",           state: "FETCH_SHIPMENT"            },
    EXTERNAL_DOC_NO: { type: "PROMPT_EXT_DOC",          state: "FETCH_EXT_DOC"             },
    TOP_ORDERS:      { type: "FETCH_LATEST",            state: "FETCH_ORDER"               },
    TOP_DELIVERIES:  { type: "FETCH_LATEST",            state: "FETCH_SHIPMENT"            },
    COMPLAINT:       { type: "PROMPT_COMPLAINT",        state: "AWAITING_COMPLAINT"        },
    STATEMENT:       { type: "PROMPT_STATEMENT_RANGE",  state: "AWAITING_STATEMENT_RANGE"  },
    GENERATE_STATEMENT: { type:"PROMPT_STATEMENT_RANGE", state: "AWAITING_STATEMENT_RANGE" },
    MAIN_MENU_CLICK: { type: "MAIN_MENU_CLICK",         state: ""                          },
});

function getMessageText(message) {
    return (message.text?.body || "").trim();
}

function getInteractiveSelection(message) {
    const interactive = message.interactive || {};
    return {
        selectionId: (interactive.button_reply?.id || interactive.list_reply?.id || "").trim(),
        itemName:    interactive.list_reply?.title || interactive.button_reply?.title || "Unknown Item",
    };
}

function normalizePhoneNumber(rawPhone) {
    let phone = rawPhone.replace(/\D/g, "");
    if (phone.startsWith("0") && phone.length === 10) phone = `254${phone.substring(1)}`;
    if (/^7\d{8}$/.test(phone)) phone = `254${phone}`;
    return phone;
}

function normalizeInteractiveKey(value = "") {
    return String(value)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "_")
        .replace(/[^A-Z0-9_]/g, "");
}

function getInteractiveAction(incomingId, incomingTitle) {
    const normalizedId = normalizeInteractiveKey(incomingId);
    const normalizedTitle = normalizeInteractiveKey(incomingTitle);
    let action = actionMap[normalizedId];

    if (!action) {
        action = actionMap[normalizedTitle] || null;
    }

    if ((!action || normalizedId === "MAIN_MENU_CLICK") && /STATEMENT|GENERATE/.test(normalizedTitle)) {
        action = actionMap.STATEMENT;
    }

    if (!action && /STATEMENT|GENERATE/.test(normalizedId)) {
        action = actionMap.STATEMENT;
    }

    return action;
}

// PA Forwarding 

async function forwardToPA(data) {
    if (!PA_WEBHOOK_URL) {
        console.error(`❌ CANNOT FORWARD TO PA (${data.meta_type}): PA_WEBHOOK_URL is not set in environment variables!`);
        return;
    }
    console.log(`[FORWARD] wa_id=${data.wa_id} id='${data.selected_button_id ?? data.incoming_button_id ?? "(n/a)"}' state='${data.state ?? "(n/a)"}' meta_type='${data.meta_type}' -> ${PA_WEBHOOK_URL}`);
    try {
        await axios.post(PA_WEBHOOK_URL, data, { timeout: 100000, httpAgent, httpsAgent });
        console.log(`Forwarded to PA: ${data.meta_type}`);
    } catch (err) {
        if (err.response) {
            console.error(`PA Error (${data.meta_type}): HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
        } else if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
            console.error(`PA Error (${data.meta_type}): Timed out after 25s`);
        } else {
            console.error(`PA Error (${data.meta_type}): ${err.message}`);
        }
    }
}

async function syncFetchFromPA(payload) {
    if (!PA_WEBHOOK_URL) {
        console.error(`❌ CANNOT SYNC FETCH FROM PA (${payload.meta_type}): PA_WEBHOOK_URL is not set in environment variables!`);
        return null;
    }
    console.log(`[FORWARD] wa_id=${payload.wa_id} id='${payload.selected_button_id ?? payload.incoming_button_id ?? "(n/a)"}' state='${payload.state ?? "(n/a)"}' meta_type='${payload.meta_type}' -> ${PA_WEBHOOK_URL} (sync)`);
    console.log(`Sync PA fetch: ${payload.meta_type}`);
    try {
        const res = await axios.post(PA_WEBHOOK_URL, payload, { timeout: 100000, httpAgent, httpsAgent });
        console.log(`Sync PA response for ${payload.meta_type}:`, res.data);
        return res.data;
    } catch (err) {
        if (err.response) {
            console.error(`Sync PA Error (${payload.meta_type}): HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
        } else if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
            console.error(`Sync PA Error (${payload.meta_type}): Timed out after 25s`);
        } else {
            console.error(`Sync PA Error (${payload.meta_type}): ${err.message}`);
        }
        return null;
    }
}


/**
 * Log a complaint submission for audit.
 * @param {string} wa_id
 * @param {string} orderId
 * @param {string} complaintText
 * @param {string} [status]
 */
async function logComplaintSubmission(wa_id, orderId, complaintText, status = "SUBMITTED") {
    const logEntry = {
        timestamp:   new Date().toISOString(),
        wa_id,
        order_id:    orderId,
        status,
        text_length: complaintText.length,
        preview:     complaintText.substring(0, 50) + (complaintText.length > 50 ? "..." : ""),
    };
    console.log(`[COMPLAINT LOG] ${JSON.stringify(logEntry)}`);
}


function logButtonRoute(wa_id, selectionId, itemName, prevState, newState, metaType) {
    console.log(`[BTN] wa_id=${wa_id} id='${selectionId}' title='${itemName}' state: '${prevState}' -> '${newState}' meta_type='${metaType}'`);
}


function fallbackPayloads(session, wa_id, customerPhone, selectedButtonId = "", incomingButtonId = "") {
    if (session.submitted_phone) {
        return [{ meta_type: "MAIN_MENU_CLICK", wa_id, customer_phone: customerPhone, selected_button_id: selectedButtonId, incoming_button_id: incomingButtonId, state: actionMap.MAIN_MENU_CLICK.state }];
    }
    return [{ meta_type: actionMap.INPUT_PHONE.type, wa_id, customer_phone: customerPhone, state: actionMap.INPUT_PHONE.state }];
}

async function handleInteractiveMessage(message, session, currentState, customerPhone, wa_id) {
    const { selectionId, itemName } = getInteractiveSelection(message);

    if (!selectionId) {
        const payload = fallbackPayloads(session, wa_id, customerPhone);
        if (message.errors?.length) {
            console.warn(`[${wa_id}] META DELIVERY FAILURE — WhatsApp sent no button/list data for this click. code=${message.errors[0].code} details='${message.errors[0].error_data?.details}'. This is NOT an extraction bug — nothing in webhook.js can recover data Meta never sent.`);
        }
        console.warn(`[${wa_id}] Interactive message with no selectionId — falling back to ${payload.map(p => p.meta_type).join(" -> ")}. currentState='${currentState}' verified=${!!session.submitted_phone} raw message=${JSON.stringify(message)}`);
        await db.save(wa_id, { ...session, state: "" });
        logButtonRoute(wa_id, "(none)", "(none)", currentState, "", payload.map(p => p.meta_type).join(" -> "));
        return { payload };
    }

    console.log(`[BTN] wa_id=${wa_id} id='${selectionId}' title='${itemName}' currentState='${currentState}'`);

    const incomingId = selectionId.toUpperCase();
    const incomingTitle = itemName.toUpperCase().replace(/_/g, " ");

    // Statement range selection 
    if (currentState === "AWAITING_STATEMENT_RANGE") {
        const matchedRange = STATEMENT_RANGES.find(
            r => incomingId.replace(/_/g, " ").includes(r) || incomingTitle.includes(r)
        );
        if (matchedRange) {
             console.log(`[STATEMENT] User ${wa_id} selected range '${matchedRange}'`);
             await db.save(wa_id, { ...session, state: "FETCH_STATEMENT" });
             logButtonRoute(wa_id, selectionId, itemName, currentState, "FETCH_STATEMENT", "FETCH_STATEMENT");
             return {
                 payload: {
                     meta_type: "FETCH_STATEMENT",
                     wa_id,
                     customer_phone: customerPhone,
                     range: matchedRange,
                 },
                 isSynchronousFetch: true,
             };
         }
    }

    // Complaint: user selects order from list 
    if (incomingId.startsWith("COMPLAINT_")) {
        const cleanOrderId = selectionId.split("_")[1] || selectionId;
        console.log(`[COMPLAINT] User ${wa_id} selected order ${cleanOrderId} for complaint`);
        await db.save(wa_id, { ...session, state: "PROMPT_COMPLAINT_TEXT", complaint_order_id: cleanOrderId, complaint_selected_at: new Date().toISOString() });
        logButtonRoute(wa_id, selectionId, itemName, currentState, "PROMPT_COMPLAINT_TEXT", "PROMPT_COMPLAINT_TEXT");
        return {
            payload: { meta_type: "PROMPT_COMPLAINT_TEXT", wa_id, customer_phone: customerPhone, order_id: cleanOrderId, order_name: itemName },
            isSynchronousFetch: false,
        };
    }

    //  Complaint fallback: PA didn't use COMPLAINT_ prefix 
    if (currentState === "AWAITING_COMPLAINT") {
        console.log(`[COMPLAINT] Fallback: User ${wa_id} selected order ${selectionId} for complaint`);
        await db.save(wa_id, { ...session, state: "PROMPT_COMPLAINT_TEXT", complaint_order_id: selectionId, complaint_selected_at: new Date().toISOString() });
        logButtonRoute(wa_id, selectionId, itemName, currentState, "PROMPT_COMPLAINT_TEXT", "PROMPT_COMPLAINT_TEXT");
        return {
            payload: { meta_type: "PROMPT_COMPLAINT_TEXT", wa_id, customer_phone: customerPhone, order_id: selectionId, order_name: itemName },
            isSynchronousFetch: false,
        };
    }

    // Known action button 
    const action = getInteractiveAction(selectionId, itemName);
    if (action) {
        const newState = normalizeInteractiveKey(selectionId) === "INPUT_PHONE" ? "" : action.state;
        if (normalizeInteractiveKey(selectionId) === "INPUT_PHONE") {
            await db.save(wa_id, { ...session, state: "", otp: "", submitted_phone: "" });
        } else {
            await db.save(wa_id, { ...session, state: action.state });
        }
        logButtonRoute(wa_id, selectionId, itemName, currentState, newState, action.type);
        return {
            payload: {
                meta_type: action.type,
                wa_id,
                customer_phone: customerPhone,
                selected_button_id: selectionId,
                incoming_button_id: normalizeInteractiveKey(selectionId),
                state: action.state,
            },
            isSynchronousFetch: false,
        };
    }

    // Product code selection 
    if (incomingId.startsWith("FG")) {
        if (currentState === "ADDING_PRODUCT") {
            await db.save(wa_id, { ...session, state: "ADD_PRODUCT_QTY", last_selected_item: itemName, last_selected_code: selectionId });
            logButtonRoute(wa_id, selectionId, itemName, currentState, "ADD_PRODUCT_QTY", "PROMPT_ADD_QTY");
            return { payload: { meta_type: "PROMPT_ADD_QTY", wa_id, customer_phone: customerPhone, item_name: itemName, item_code: selectionId } };
        }
        await db.save(wa_id, { ...session, state: "AWAITING_EXT_DOC_FOR_QUOTE", last_selected_item: itemName, last_selected_code: selectionId });
        logButtonRoute(wa_id, selectionId, itemName, currentState, "AWAITING_EXT_DOC_FOR_QUOTE", "PROMPT_EXT_DOC");
        return { payload: { meta_type: "PROMPT_EXT_DOC", wa_id, customer_phone: customerPhone, item_name: itemName, item_code: selectionId } };
    }

    //  Fallback: reset to main menu (or ask for phone if unverified) 
    const fallback = fallbackPayloads(session, wa_id, customerPhone, selectionId, incomingId);
    console.warn(`[${wa_id}] Unrecognized interactive selectionId='${selectionId}' incomingId='${incomingId}' itemName='${itemName}' — falling back to ${fallback.map(p => p.meta_type).join(" -> ")}. verified=${!!session.submitted_phone}`);
    await db.save(wa_id, { ...session, state: "" });
    logButtonRoute(wa_id, selectionId, itemName, currentState, "", fallback.map(p => p.meta_type).join(" -> "));
    return { payload: fallback };
}

// Text message handler 

async function handleTextMessage(text, session, currentState, customerPhone, wa_id) {
    switch (currentState) {

        //  Awaiting statement range (typed) 
        case "AWAITING_STATEMENT_RANGE": {
            const textRange = text.trim();
            const matched = STATEMENT_RANGES.find(r => textRange.toUpperCase().includes(r));

            if (!matched) {
                console.warn(`[STATEMENT] Invalid range entered by ${wa_id}: '${textRange}'`);
                await db.save(wa_id, { ...session, state: "AWAITING_STATEMENT_RANGE" });
                return {
                    payload: {
                        meta_type: "USER_MESSAGE",
                        wa_id,
                        customer_phone: customerPhone,
                        message_content: "INVALID_STATEMENT_RANGE",
                    },
                };
            }

            await db.save(wa_id, { ...session, state: "FETCH_STATEMENT" });
            return {
                payload: {
                    meta_type: "FETCH_STATEMENT",
                    wa_id,
                    customer_phone: customerPhone,
                    range: matched,
                },
                isSynchronousFetch: true,
            };
        }

        //  Statement (fallback when already in FETCH_STATEMENT) 
        case "FETCH_STATEMENT":
            await db.save(wa_id, { ...session, state: "" });
            return { payload: { meta_type: "FETCH_STATEMENT", wa_id, customer_phone: customerPhone, details: text }, isSynchronousFetch: true };

        case "PROMPT_COMPLAINT_TEXT": {
            const complaintText = text.trim();

            if (complaintText.length < COMPLAINT_MIN_LENGTH) {
                console.warn(`[COMPLAINT] Too short (${complaintText.length} chars) — ${wa_id}`);
                await db.save(wa_id, { ...session, state: "PROMPT_COMPLAINT_TEXT" });
                return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "COMPLAINT_TOO_SHORT", minimum_length: COMPLAINT_MIN_LENGTH } };
            }

            if (complaintText.length > COMPLAINT_MAX_LENGTH) {
                console.warn(`[COMPLAINT] Too long (${complaintText.length} chars) — ${wa_id}`);
                await db.save(wa_id, { ...session, state: "PROMPT_COMPLAINT_TEXT" });
                return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "COMPLAINT_TOO_LONG", maximum_length: COMPLAINT_MAX_LENGTH } };
            }

            const orderId = session.complaint_order_id || "";
            if (!orderId) {
                console.error(`[COMPLAINT] Missing complaint_order_id for ${wa_id}`);
                await db.save(wa_id, { ...session, state: "" });
                return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "COMPLAINT_ERROR_NO_ORDER" } };
            }

            await logComplaintSubmission(wa_id, orderId, complaintText, "SUBMITTED");

            await db.save(wa_id, { ...session, state: "", complaint_order_id: orderId, complaint_submitted_at: new Date().toISOString(), complaint_text_length: complaintText.length });
            return { payload: { meta_type: "POST_COMPLAINT", wa_id, customer_phone: customerPhone, order_id: orderId, complaint_text: complaintText, submitted_at: new Date().toISOString() } };
        }

        //  Complaint: user typed order ID while waiting
        case "AWAITING_COMPLAINT": {
            const orderInput = text.trim();
            console.log(`[COMPLAINT] User ${wa_id} typed order '${orderInput}' for complaint`);
            await db.save(wa_id, { ...session, state: "PROMPT_COMPLAINT_TEXT", complaint_order_id: orderInput, complaint_selected_at: new Date().toISOString() });
            return { payload: { meta_type: "PROMPT_COMPLAINT_TEXT", wa_id, customer_phone: customerPhone, order_id: orderInput, order_name: orderInput } };
        }

        //  Quote: external doc number 
        case "AWAITING_EXT_DOC_FOR_QUOTE":
            await db.save(wa_id, { ...session, state: "AWAITING_QUANTITY", external_doc_no: text });
            return { payload: { meta_type: "AWAITING_QUANTITY", wa_id, customer_phone: customerPhone, external_doc_no: text } };

        //  Quote: quantity 
        case "AWAITING_QUANTITY": {
            const qty = parseInt(text.replace(/\D/g, ""), 10);
            if (!isNaN(qty) && qty > 0) {
                await db.save(wa_id, { ...session, state: "" });
                return { payload: { meta_type: "CREATE_SALES_QUOTE", wa_id, customer_phone: customerPhone, item_name: session.last_selected_item, item_code: session.last_selected_code, quantity: qty, external_doc_no: session.external_doc_no } };
            }
            return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "INVALID_QUANTITY_FORMAT" } };
        }

        //  Product: add quantity
        case "ADD_PRODUCT_QTY": {
            const qty = parseInt(text.replace(/\D/g, ""), 10);
            if (!isNaN(qty) && qty > 0) {
                await db.save(wa_id, { ...session, state: "" });
                return { payload: { meta_type: "POST_ITEM_ADDED", wa_id, customer_phone: customerPhone, item_name: session.last_selected_item, item_code: session.last_selected_code, quantity: qty, external_doc_no: session.external_doc_no } };
            }
            return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "INVALID_QUANTITY_FORMAT" } };
        }

        //  External doc lookup 
        case "FETCH_EXT_DOC":
            await db.save(wa_id, { ...session, state: "" });
            return { payload: { meta_type: "EXT_DOC_NUMBER_SUBMITTED", wa_id, customer_phone: customerPhone, doc_number: text } };

        //  Customer code 
        case "CUSTOMER_CODE":
        case "ADDING_PRODUCT":
            await db.save(wa_id, { ...session, state: "" });
            return { payload: { meta_type: "SUBMIT_CUSTOMER_CODE", wa_id, customer_phone: customerPhone, code: text } };

        //  Collect quote 
        case "COLLECT_QUOTE": {
            const qtyMatch = text.match(/\d+/);
            const q    = qtyMatch ? parseInt(qtyMatch[0], 10) : null;
            const name = text.replace(/\d+/g, "").replace(/[,.-]/g, "").trim();
            if (name && q) {
                await db.save(wa_id, { ...session, state: "" });
                return { payload: { meta_type: "CREATE_SALES_QUOTE", wa_id, customer_phone: customerPhone, item_name: name, quantity: q, raw_order_text: text } };
            }
            return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "INVALID_QUOTE_FORMAT" } };
        }

        //  Default / unknown state 
        default:
            return handleDefaultTextMessage(text, session, currentState, customerPhone, wa_id);
    }
}

// Default / catch-all text handler 

async function handleDefaultTextMessage(text, session, currentState, customerPhone, wa_id) {
    //  OTP verification — timingSafeEqual prevents timing-based enumeration 
    if (/^\d{6}$/.test(text) && session.otp) {
        try {
            const isMatch = crypto.timingSafeEqual(Buffer.from(String(session.otp)), Buffer.from(text));
            if (isMatch) await db.save(wa_id, { ...session, otp: "", state: "" });
            return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: isMatch ? "VERIFIED_SUCCESS" : "VERIFIED_FAILED" } };
        } catch (err) {
            console.error(`[${wa_id}] OTP comparison failed: ${err.message}`);
            return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "VERIFIED_FAILED" } };
        }
    }

    // Doc number in FETCH* state 
    if (/^[a-zA-Z0-9\-\/]+$/.test(text) && currentState.startsWith("FETCH")) {
        await db.save(wa_id, { ...session, state: "" });
        return { payload: { meta_type: "DOC_NUMBER_SUBMITTED", wa_id, customer_phone: customerPhone, search_type: currentState, doc_number: text } };
    }

    // Phone number → OTP generation
    if (/^\d{9,15}$/.test(text.replace(/\D/g, "")) && !session.submitted_phone) {
        const cleanPhone = normalizePhoneNumber(text);
        const otp        = String(crypto.randomInt(100000, 1000000));
        await db.save(wa_id, { ...session, otp, submitted_phone: cleanPhone });
        console.log(`[DEBUG] OTP for ${wa_id}: ${otp}`);
        return { payload: { meta_type: "SEND_OTP", wa_id, submitted_phone: cleanPhone, customer_phone: cleanPhone, otp_code: otp } };
    }

    // Already authenticated but unrecognised input 
    if (session.submitted_phone) {
        return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "UNRECOGNIZED_INPUT" } };
    }

    // Not authenticated → ask for phone 
    await db.save(wa_id, { ...session, state: "INPUT_PHONE_READY" });
    return { payload: { meta_type: "USER_MESSAGE", wa_id, customer_phone: customerPhone, message_content: "ASK_FOR_PHONE" } };
}

// Main Handler 

async function webhookHandler(req, res) {
    const startedAt = Date.now();
    let wa_id = "unknown";
    try {
        const value   = req.body.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];

        if (!message) {
            console.log(`[IN] no message payload — statuses/other event, ignored (${Date.now() - startedAt}ms)`);
            return res.status(200).send("EVENT_RECEIVED");
        }

        wa_id = message.from;
        if (!wa_id) {
            console.warn("Received message with no wa_id — skipped");
            return res.status(200).send("EVENT_RECEIVED");
        }

        const text = getMessageText(message);

        const sessionStartedAt = Date.now();
        const session          = (await db.get(wa_id)) || {};
        console.log(`[DB] get wa_id=${wa_id} found=${!!session.updated_at} took=${Date.now() - sessionStartedAt}ms`);

        const currentState  = session.state || "";
        const customerPhone = session.submitted_phone || "";

        console.log(`[IN] wa_id=${wa_id} from_phone_number_id=${value?.metadata?.phone_number_id ?? "(n/a)"} to_display_number=${value?.metadata?.display_phone_number ?? "(n/a)"} type=${message.type} currentState='${currentState}' text='${text}' interactive=${JSON.stringify(message.interactive ?? null)}`);

        const result = message.type === "interactive"
            ? await handleInteractiveMessage(message, session, currentState, customerPhone, wa_id)
            : await handleTextMessage(text, session, currentState, customerPhone, wa_id);

        const payload            = result?.payload || null;
        const isSynchronousFetch = result?.isSynchronousFetch || false;

        if (!payload || (Array.isArray(payload) && payload.length === 0)) {
            console.log(`[OUT] wa_id=${wa_id} no payload — nothing forwarded (${Date.now() - startedAt}ms)`);
            return res.status(200).send("EVENT_RECEIVED");
        }

        const payloads = Array.isArray(payload) ? payload : [payload];
        for (const p of payloads) {
            console.log(`[OUT] wa_id=${wa_id} id=${p.selected_button_id ?? p.incoming_button_id ?? "(n/a)"} state=${p.state ?? "(n/a)"} meta_type='${p.meta_type}' sync=${isSynchronousFetch}`);
        }

        if (isSynchronousFetch) {
            await syncFetchFromPA(payloads[0]);
            console.log(`[DONE] wa_id=${wa_id} total=${Date.now() - startedAt}ms sync=true`);
            return res.status(200).send("EVENT_RECEIVED_AND_PROCESSED");
        }

        for (const p of payloads) {
            await forwardToPA(p);
        }
        console.log(`[DONE] wa_id=${wa_id} total=${Date.now() - startedAt}ms sync=false`);
        return res.status(200).send("EVENT_RECEIVED");

    } catch (err) {
        console.error(`WEBHOOK ERROR [wa_id=${wa_id}] after ${Date.now() - startedAt}ms: ${err.message}\n${err.stack}`);
        if (!res.headersSent) res.status(200).send("EVENT_ERROR_HANDLED");
    }
}

module.exports = { webhookHandler };
