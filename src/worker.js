const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function now() {
  return Date.now();
}

function id() {
  return crypto.randomUUID();
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function bearer(request) {
  return (request.headers.get("authorization") || "")
    .replace(/^Bearer\s+/i, "");
}

function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN || "";
  return Boolean(expected && bearer(request) === expected);
}

async function isBlocked(env, deviceId) {
  if (!deviceId) return false;

  const row = await env.DB
    .prepare("SELECT 1 FROM blocked_devices WHERE device_id = ?")
    .bind(deviceId)
    .first();

  return Boolean(row);
}

function validCoordinates(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ADMIN HTML
      if (path === "/admin" || path === "/admin/") {
        // Serve the admin document internally from a non-HTML asset name.
        // This avoids Cloudflare Assets canonical HTML redirects (/admin.html -> /admin)
        // which otherwise create ERR_TOO_MANY_REDIRECTS.
        const assetUrl = new URL("/admin-panel.asset", url);
        const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
        if (!asset.ok) return new Response("Panel administrativo no disponible", { status: 500 });
        const headers = new Headers(asset.headers);
        headers.set("content-type", "text/html; charset=utf-8");
        headers.set("cache-control", "no-store");
        return new Response(asset.body, { status: 200, headers });
      }

      // STATIC FILES
      if (!path.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      // HEALTH
      if (path === "/api/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "Vial Reynosa"
        });
      }

      // CATEGORIES
      if (path === "/api/categories" && request.method === "GET") {
        const { results } = await env.DB
          .prepare(
            `SELECT id, name, icon, enabled, ttl_minutes
             FROM categories
             ORDER BY rowid`
          )
          .all();

        return json(results);
      }

      // ACTIVE INCIDENTS
      if (path === "/api/incidents" && request.method === "GET") {
        const t = now();

        const { results } = await env.DB
          .prepare(
            `SELECT *
             FROM incidents
             WHERE status = 'active'
             AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY created_at DESC
             LIMIT 500`
          )
          .bind(t)
          .all();

        return json(results);
      }

      // CREATE INCIDENT
      if (path === "/api/incidents" && request.method === "POST") {
        const b = await body(request);

        const category = String(b.category || "").trim();
        const lat = Number(b.lat);
        const lng = Number(b.lng);
        const text = String(b.text || "").trim().slice(0, 500);
        const deviceId = String(b.device_id || "").trim().slice(0, 200);

        if (await isBlocked(env, deviceId)) {
          return json({ error: "blocked" }, 403);
        }

        if (!category || !validCoordinates(lat, lng)) {
          return json({ error: "invalid_data" }, 400);
        }

        const categoryRow = await env.DB
          .prepare(
            `SELECT ttl_minutes, enabled
             FROM categories
             WHERE id = ?`
          )
          .bind(category)
          .first();

        if (!categoryRow) {
          return json({ error: "unknown_category" }, 400);
        }

        if (!categoryRow.enabled) {
          return json({ error: "category_disabled" }, 400);
        }

        const createdAt = now();
        const expiresAt =
          createdAt + Number(categoryRow.ttl_minutes) * 60 * 1000;

        const incidentId = id();

        await env.DB
          .prepare(
            `INSERT INTO incidents
             (
               id,
               category,
               lat,
               lng,
               text,
               confirmations,
               status,
               device_id,
               created_at,
               updated_at,
               expires_at
             )
             VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`
          )
          .bind(
            incidentId,
            category,
            lat,
            lng,
            text,
            deviceId || null,
            createdAt,
            createdAt,
            expiresAt
          )
          .run();

        return json(
          {
            ok: true,
            id: incidentId
          },
          201
        );
      }

      // SINGLE INCIDENT
      const incidentMatch = path.match(
        /^\/api\/incidents\/([^/]+)$/
      );

      if (incidentMatch && request.method === "GET") {
        const incidentId = decodeURIComponent(incidentMatch[1]);

        const incident = await env.DB
          .prepare("SELECT * FROM incidents WHERE id = ?")
          .bind(incidentId)
          .first();

        if (!incident) {
          return json({ error: "not_found" }, 404);
        }

        return json(incident);
      }

      // VOTE / CONFIRM INCIDENT
      const voteMatch = path.match(
        /^\/api\/incidents\/([^/]+)\/vote$/
      );

      if (voteMatch && request.method === "POST") {
        const incidentId = decodeURIComponent(voteMatch[1]);
        const b = await body(request);

        const deviceId = String(b.device_id || "")
          .trim()
          .slice(0, 200);

        const vote = String(b.vote || "still")
          .trim()
          .slice(0, 20);

        if (!deviceId) {
          return json({ error: "device_required" }, 400);
        }

        if (await isBlocked(env, deviceId)) {
          return json({ error: "blocked" }, 403);
        }

        const incident = await env.DB
          .prepare(
            `SELECT id, status
             FROM incidents
             WHERE id = ?`
          )
          .bind(incidentId)
          .first();

        if (!incident) {
          return json({ error: "not_found" }, 404);
        }

        const previous = await env.DB
          .prepare(
            `SELECT vote
             FROM votes
             WHERE incident_id = ?
             AND device_id = ?`
          )
          .bind(incidentId, deviceId)
          .first();

        await env.DB
          .prepare(
            `INSERT INTO votes
             (incident_id, device_id, vote, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(incident_id, device_id)
             DO UPDATE SET
               vote = excluded.vote,
               created_at = excluded.created_at`
          )
          .bind(incidentId, deviceId, vote, now())
          .run();

        if (vote === "still" && previous?.vote !== "still") {
          await env.DB
            .prepare(
              `UPDATE incidents
               SET confirmations = confirmations + 1,
                   updated_at = ?
               WHERE id = ?`
            )
            .bind(now(), incidentId)
            .run();
        }

        if (vote === "gone") {
          const result = await env.DB
            .prepare(
              `SELECT COUNT(*) AS total
               FROM votes
               WHERE incident_id = ?
               AND vote = 'gone'`
            )
            .bind(incidentId)
            .first();

          if (Number(result?.total || 0) >= 3) {
            await env.DB
              .prepare(
                `UPDATE incidents
                 SET status = 'closed',
                     updated_at = ?
                 WHERE id = ?`
              )
              .bind(now(), incidentId)
              .run();
          }
        }

        return json({ ok: true });
      }

      // COMMENTS
      const commentsMatch = path.match(
        /^\/api\/incidents\/([^/]+)\/comments$/
      );

      if (commentsMatch && request.method === "GET") {
        const incidentId = decodeURIComponent(commentsMatch[1]);

        const { results } = await env.DB
          .prepare(
            `SELECT id, incident_id, text, created_at
             FROM comments
             WHERE incident_id = ?
             AND status = 'active'
             ORDER BY created_at ASC
             LIMIT 200`
          )
          .bind(incidentId)
          .all();

        return json(results);
      }

      if (commentsMatch && request.method === "POST") {
        const incidentId = decodeURIComponent(commentsMatch[1]);
        const b = await body(request);

        const text = String(b.text || "").trim().slice(0, 500);
        const deviceId = String(b.device_id || "")
          .trim()
          .slice(0, 200);

        if (!text) {
          return json({ error: "empty_comment" }, 400);
        }

        if (await isBlocked(env, deviceId)) {
          return json({ error: "blocked" }, 403);
        }

        const incident = await env.DB
          .prepare(
            `SELECT id
             FROM incidents
             WHERE id = ?
             AND status = 'active'`
          )
          .bind(incidentId)
          .first();

        if (!incident) {
          return json({ error: "incident_not_found" }, 404);
        }

        const commentId = id();

        await env.DB
          .prepare(
            `INSERT INTO comments
             (
               id,
               incident_id,
               text,
               device_id,
               status,
               created_at
             )
             VALUES (?, ?, ?, ?, 'active', ?)`
          )
          .bind(
            commentId,
            incidentId,
            text,
            deviceId || null,
            now()
          )
          .run();

        return json(
          {
            ok: true,
            id: commentId
          },
          201
        );
      }

      // ACTIVE ALERTS
      if (path === "/api/alerts" && request.method === "GET") {
        const { results } = await env.DB
          .prepare(
            `SELECT id, title, body, created_at
             FROM alerts
             WHERE active = 1
             ORDER BY created_at DESC`
          )
          .all();

        return json(results);
      }

      // ACTIVE ADS
      if (path === "/api/ads" && request.method === "GET") {
        const t = now();

        const { results } = await env.DB
          .prepare(
            `SELECT id, name, body, link,
                    starts_at, ends_at
             FROM ads
             WHERE active = 1
             AND (starts_at IS NULL OR starts_at <= ?)
             AND (ends_at IS NULL OR ends_at >= ?)
             ORDER BY created_at DESC`
          )
          .bind(t, t)
          .all();

        return json(results);
      }

      // SETTINGS
      if (path === "/api/settings" && request.method === "GET") {
        const { results } = await env.DB
          .prepare(
            `SELECT key, value
             FROM settings`
          )
          .all();

        const settings = {};

        for (const row of results) {
          settings[row.key] = row.value;
        }

        return json(settings);
      }

      // -------------------------
      // ADMIN API
      // -------------------------

      if (path.startsWith("/api/admin/")) {
        if (!isAdmin(request, env)) {
          return json({ error: "unauthorized" }, 401);
        }

        // ADMIN DASHBOARD
        if (
          path === "/api/admin/dashboard" &&
          request.method === "GET"
        ) {
          const activeIncidents = await env.DB
            .prepare(
              `SELECT COUNT(*) AS total
               FROM incidents
               WHERE status = 'active'
               AND (expires_at IS NULL OR expires_at > ?)`
            )
            .bind(now())
            .first();

          const comments = await env.DB
            .prepare(
              `SELECT COUNT(*) AS total
               FROM comments
               WHERE status = 'active'`
            )
            .first();

          const alerts = await env.DB
            .prepare(
              `SELECT COUNT(*) AS total
               FROM alerts
               WHERE active = 1`
            )
            .first();

          return json({
            incidents: Number(activeIncidents?.total || 0),
            comments: Number(comments?.total || 0),
            alerts: Number(alerts?.total || 0)
          });
        }

        // ADMIN INCIDENTS
        if (
          path === "/api/admin/incidents" &&
          request.method === "GET"
        ) {
          const { results } = await env.DB
            .prepare(
              `SELECT *
               FROM incidents
               ORDER BY created_at DESC
               LIMIT 1000`
            )
            .all();

          return json(results);
        }

        const adminIncidentMatch = path.match(
          /^\/api\/admin\/incidents\/([^/]+)$/
        );

        if (
          adminIncidentMatch &&
          (request.method === "PATCH" ||
            request.method === "POST")
        ) {
          const incidentId = decodeURIComponent(
            adminIncidentMatch[1]
          );

          const b = await body(request);

          const status = String(
            b.status || "active"
          ).slice(0, 20);

          await env.DB
            .prepare(
              `UPDATE incidents
               SET status = ?,
                   updated_at = ?
               WHERE id = ?`
            )
            .bind(status, now(), incidentId)
            .run();

          return json({ ok: true });
        }

        if (
          adminIncidentMatch &&
          request.method === "DELETE"
        ) {
          const incidentId = decodeURIComponent(
            adminIncidentMatch[1]
          );

          await env.DB
            .prepare(
              `DELETE FROM incidents
               WHERE id = ?`
            )
            .bind(incidentId)
            .run();

          return json({ ok: true });
        }

        // ADMIN COMMENTS
        if (
          path === "/api/admin/comments" &&
          request.method === "GET"
        ) {
          const { results } = await env.DB
            .prepare(
              `SELECT c.*,
                      i.category
               FROM comments c
               LEFT JOIN incidents i
                 ON i.id = c.incident_id
               ORDER BY c.created_at DESC
               LIMIT 1000`
            )
            .all();

          return json(results);
        }

        const adminCommentMatch = path.match(
          /^\/api\/admin\/comments\/([^/]+)$/
        );

        if (
          adminCommentMatch &&
          request.method === "DELETE"
        ) {
          const commentId = decodeURIComponent(
            adminCommentMatch[1]
          );

          await env.DB
            .prepare(
              `UPDATE comments
               SET status = 'removed'
               WHERE id = ?`
            )
            .bind(commentId)
            .run();

          return json({ ok: true });
        }

        // ADMIN CATEGORIES
        if (
          path === "/api/admin/categories" &&
          request.method === "GET"
        ) {
          const { results } = await env.DB
            .prepare(
              `SELECT *
               FROM categories
               ORDER BY rowid`
            )
            .all();

          return json(results);
        }

        const categoryMatch = path.match(
          /^\/api\/admin\/categories\/([^/]+)$/
        );

        if (
          categoryMatch &&
          (request.method === "PATCH" ||
            request.method === "POST")
        ) {
          const categoryId = decodeURIComponent(
            categoryMatch[1]
          );

          const b = await body(request);

          const enabled =
            b.enabled === true ||
            b.enabled === 1 ||
            b.enabled === "1"
              ? 1
              : 0;

          const ttl = Math.max(
            1,
            Number(b.ttl_minutes || 180)
          );

          await env.DB
            .prepare(
              `UPDATE categories
               SET enabled = ?,
                   ttl_minutes = ?
               WHERE id = ?`
            )
            .bind(enabled, ttl, categoryId)
            .run();

          return json({ ok: true });
        }

        // ADMIN ALERTS
        if (
          path === "/api/admin/alerts" &&
          request.method === "GET"
        ) {
          const { results } = await env.DB
            .prepare(
              `SELECT *
               FROM alerts
               ORDER BY created_at DESC`
            )
            .all();

          return json(results);
        }

        if (
          path === "/api/admin/alerts" &&
          request.method === "POST"
        ) {
          const b = await body(request);

          const title = String(b.title || "")
            .trim()
            .slice(0, 120);

          const alertBody = String(b.body || "")
            .trim()
            .slice(0, 1000);

          if (!title || !alertBody) {
            return json({ error: "invalid_data" }, 400);
          }

          const alertId = id();

          await env.DB
            .prepare(
              `INSERT INTO alerts
               (
                 id,
                 title,
                 body,
                 active,
                 created_at
               )
               VALUES (?, ?, ?, 1, ?)`
            )
            .bind(
              alertId,
              title,
              alertBody,
              now()
            )
            .run();

          return json(
            {
              ok: true,
              id: alertId
            },
            201
          );
        }

        const alertMatch = path.match(
          /^\/api\/admin\/alerts\/([^/]+)$/
        );

        if (
          alertMatch &&
          request.method === "DELETE"
        ) {
          const alertId = decodeURIComponent(
            alertMatch[1]
          );

          await env.DB
            .prepare(
              `UPDATE alerts
               SET active = 0
               WHERE id = ?`
            )
            .bind(alertId)
            .run();

          return json({ ok: true });
        }

        // ADMIN ADS
        if (
          path === "/api/admin/ads" &&
          request.method === "GET"
        ) {
          const { results } = await env.DB
            .prepare(
              `SELECT *
               FROM ads
               ORDER BY created_at DESC`
            )
            .all();

          return json(results);
        }

        if (
          path === "/api/admin/ads" &&
          request.method === "POST"
        ) {
          const b = await body(request);

          const name = String(b.name || "")
            .trim()
            .slice(0, 120);

          const adBody = String(b.body || "")
            .trim()
            .slice(0, 1000);

          const link = String(b.link || "")
            .trim()
            .slice(0, 1000);

          const startsAt = b.starts_at
            ? Number(b.starts_at)
            : null;

          const endsAt = b.ends_at
            ? Number(b.ends_at)
            : null;

          if (!name || !adBody) {
            return json({ error: "invalid_data" }, 400);
          }

          const adId = id();

          await env.DB
            .prepare(
              `INSERT INTO ads
               (
                 id,
                 name,
                 body,
                 link,
                 active,
                 starts_at,
                 ends_at,
                 created_at
               )
               VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
            )
            .bind(
              adId,
              name,
              adBody,
              link || null,
              startsAt,
              endsAt,
              now()
            )
            .run();

          return json(
            {
              ok: true,
              id: adId
            },
            201
          );
        }

        const adMatch = path.match(
          /^\/api\/admin\/ads\/([^/]+)$/
        );

        if (adMatch && request.method === "DELETE") {
          const adId = decodeURIComponent(adMatch[1]);

          await env.DB
            .prepare(
              `UPDATE ads
               SET active = 0
               WHERE id = ?`
            )
            .bind(adId)
            .run();

          return json({ ok: true });
        }

        // ADMIN SETTINGS
        if (
          path === "/api/admin/settings" &&
          request.method === "POST"
        ) {
          const b = await body(request);

          const key = String(b.key || "")
            .trim()
            .slice(0, 100);

          const value = String(b.value ?? "")
            .slice(0, 2000);

          if (!key) {
            return json({ error: "invalid_key" }, 400);
          }

          await env.DB
            .prepare(
              `INSERT INTO settings
               (key, value, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(key)
               DO UPDATE SET
                 value = excluded.value,
                 updated_at = excluded.updated_at`
            )
            .bind(key, value, now())
            .run();

          return json({ ok: true });
        }

        // BLOCK DEVICE
        if (
          path === "/api/admin/block-device" &&
          request.method === "POST"
        ) {
          const b = await body(request);

          const deviceId = String(b.device_id || "")
            .trim()
            .slice(0, 200);

          const reason = String(b.reason || "")
            .trim()
            .slice(0, 500);

          if (!deviceId) {
            return json({ error: "device_required" }, 400);
          }

          await env.DB
            .prepare(
              `INSERT INTO blocked_devices
               (device_id, reason, created_at)
               VALUES (?, ?, ?)
               ON CONFLICT(device_id)
               DO UPDATE SET
                 reason = excluded.reason`
            )
            .bind(deviceId, reason || null, now())
            .run();

          return json({ ok: true });
        }

        return json(
          { error: "admin_route_not_found" },
          404
        );
      }

      return json({ error: "route_not_found" }, 404);
    } catch (error) {
      console.error(error);

      return json(
        {
          error: "server_error"
        },
        500
      );
    }
  }
};
