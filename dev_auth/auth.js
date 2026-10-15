'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { query, transaction } = require('./db/postgres');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET absent ou trop court dans secrets/.env');
}

function safeText(value, max = 160) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)
    : '';
}

async function recordAnalysisStart(userId, context) {
  try {
    const result = await query(`
      INSERT INTO analysis_events
        (user_id, match_text, competition, match_date, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id
    `, [
      userId,
      safeText(context?.match, 240),
      safeText(context?.championnat, 120),
      safeText(context?.date, 80)
    ]);
    return Number(result.rows[0].id);
  } catch (error) {
    console.error('Journal analyse indisponible :', error.message);
    return null;
  }
}

async function finishAnalysisEvent(id, status) {
  if (!id || !['success', 'error'].includes(status)) return;
  try {
    await query(`
      UPDATE analysis_events
      SET status = $1,
          completed_at = to_char(
            clock_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
      WHERE id = $2
    `, [status, id]);
  } catch (error) {
    console.error('Mise à jour journal analyse impossible :', error.message);
  }
}

const COOKIE = 'zouzoua_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  maxAge: SESSION_MS
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessaie dans 15 minutes.' }
});

function issueSession(res, user) {
  const token = jwt.sign(
    { sub: String(user.id), phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: '8h', issuer: 'zouzoua-pronostic' }
  );
  res.cookie(COOKIE, token, cookieOptions);
}

function readToken(req) {
  const header = req.headers.cookie || '';
  const item = header.split(';').map(s => s.trim())
    .find(s => s.startsWith(COOKIE + '='));
  if (!item) return null;
  try {
    return decodeURIComponent(item.slice(COOKIE.length + 1));
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
}

async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Connexion requise.' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'zouzoua-pronostic'
    });
  } catch {
    clearSession(res);
    return res.status(401).json({ error: 'Session expirée. Reconnecte-toi.' });
  }

  const userId = Number(payload.sub);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    clearSession(res);
    return res.status(401).json({ error: 'Session invalide. Reconnecte-toi.' });
  }

  try {
    const result = await query(
      'SELECT id, phone, role, suspended FROM users WHERE id = $1',
      [userId]
    );
    const user = result.rows[0];

    if (!user) {
      clearSession(res);
      return res.status(401).json({
        error: 'Compte introuvable. Reconnecte-toi.'
      });
    }

    if (Number(user.suspended) === 1) {
      clearSession(res);
      return res.status(403).json({
        error: 'Compte suspendu. Contacte le support.'
      });
    }

    req.user = {
      id: Number(user.id),
      phone: user.phone,
      role: user.role
    };
    return next();
  } catch (error) {
    console.error('Erreur vérification session :', error.message);
    return res.status(500).json({
      error: 'Vérification de la session momentanément impossible.'
    });
  }
}

async function releaseAnalysisQuota(userId, day, kind) {
  try {
    await transaction(async client => {
      if (kind === 'free') {
        await client.query(`
          UPDATE daily_usage
          SET free_used = GREATEST(free_used - 1, 0)
          WHERE user_id = $1 AND usage_date = $2
        `, [userId, day]);
      } else {
        await client.query(`
          UPDATE daily_usage
          SET rewarded_used = GREATEST(rewarded_used - 1, 0)
          WHERE user_id = $1 AND usage_date = $2
        `, [userId, day]);

        await client.query(`
          INSERT INTO reward_credits (user_id, credits)
          VALUES ($1, 1)
          ON CONFLICT (user_id)
          DO UPDATE SET credits = reward_credits.credits + 1
        `, [userId]);
      }
    });
  } catch (error) {
    console.error('Impossible de restituer une utilisation :', error.message);
  }
}

async function enforceDailyQuota(req, res, next) {
  const userId = req.user && req.user.id;
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(401).json({ error: 'Connexion requise.' });
  }

  // Les administrateurs ne consomment pas de quota.
  if (req.user.role === 'admin') return next();

  const day = new Date().toISOString().slice(0, 10);
  let kind;

  try {
    const outcome = await transaction(async client => {
      await client.query(`
        INSERT INTO daily_usage (user_id, usage_date)
        VALUES ($1, $2)
        ON CONFLICT (user_id, usage_date) DO NOTHING
      `, [userId, day]);

      const usageResult = await client.query(`
        SELECT free_used
        FROM daily_usage
        WHERE user_id = $1 AND usage_date = $2
        FOR UPDATE
      `, [userId, day]);

      const usage = usageResult.rows[0];
      if (!usage) throw new Error('Compteur quotidien introuvable.');

      if (Number(usage.free_used) < 3) {
        await client.query(`
          UPDATE daily_usage
          SET free_used = free_used + 1
          WHERE user_id = $1 AND usage_date = $2
        `, [userId, day]);
        return { kind: 'free' };
      }

      const creditResult = await client.query(`
        SELECT credits FROM reward_credits
        WHERE user_id = $1
        FOR UPDATE
      `, [userId]);

      const credit = creditResult.rows[0];
      if (!credit || Number(credit.credits) < 1) {
        return { limitReached: true };
      }

      const debit = await client.query(`
        UPDATE reward_credits
        SET credits = credits - 1
        WHERE user_id = $1 AND credits > 0
      `, [userId]);

      if (debit.rowCount !== 1) return { limitReached: true };

      await client.query(`
        UPDATE daily_usage
        SET rewarded_used = rewarded_used + 1
        WHERE user_id = $1 AND usage_date = $2
      `, [userId, day]);

      return { kind: 'rewarded' };
    });

    if (outcome.limitReached) {
      return res.status(429).json({
        code: 'DAILY_LIMIT_REACHED',
        error: 'Tes 3 analyses gratuites du jour sont utilisées. Une publicité récompensée validée sera nécessaire pour obtenir une analyse supplémentaire.'
      });
    }

    kind = outcome.kind;
  } catch (error) {
    console.error('Erreur compteur quotidien :', error.message);
    return res.status(500).json({
      error: 'Vérification du quota impossible.'
    });
  }

  // Une analyse échouée ne consomme pas l'utilisation réservée.
  let released = false;
  res.on('finish', () => {
    if (!released && res.statusCode >= 400) {
      released = true;
      void releaseAnalysisQuota(userId, day, kind);
    }
  });

  return next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      error: 'Accès réservé aux administrateurs.'
    });
  }
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.id !== 5) {
    return res.status(403).json({
      error: 'Action réservée au super administrateur.'
    });
  }
  return next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function attachAuth(app) {
  app.post('/api/register', authLimiter, asyncRoute(async (req, res) => {
    const phone = String(req.body?.phone || '').replace(/[\s().-]/g, '');
    const password = req.body?.password;

    if (!/^\+?[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({
        error: 'Entre un numéro international valide, par exemple +2250700000000.'
      });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: 'Le mot de passe doit contenir entre 8 et 128 caractères.'
      });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      const result = await query(`
        INSERT INTO users (phone, password_hash)
        VALUES ($1, $2)
        RETURNING id, phone
      `, [phone, hash]);

      const user = result.rows[0];
      issueSession(res, user);
      return res.status(201).json({ ok: true, phone: user.phone });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Ce numéro possède déjà un compte.'
        });
      }
      console.error('Erreur inscription :', err.message);
      return res.status(500).json({
        error: 'Impossible de créer le compte.'
      });
    }
  }));

  app.post('/api/login', authLimiter, asyncRoute(async (req, res) => {
    const phone = String(req.body?.phone || '').replace(/[\s().-]/g, '');
    const password = req.body?.password;

    if (!/^\+?[1-9]\d{7,14}$/.test(phone) ||
        typeof password !== 'string' || password.length > 128) {
      return res.status(400).json({
        error: 'Numéro ou mot de passe invalide.'
      });
    }

    try {
      const result = await query(`
        SELECT id, phone, password_hash, suspended
        FROM users
        WHERE phone = $1
      `, [phone]);
      const user = result.rows[0];
      const valid = user && await bcrypt.compare(password, user.password_hash);

      if (!valid) {
        return res.status(401).json({
          error: 'Numéro ou mot de passe incorrect.'
        });
      }

      if (Number(user.suspended) === 1) {
        return res.status(403).json({ error: 'Ce compte est suspendu.' });
      }

      issueSession(res, user);
      try {
        await query(
          'INSERT INTO login_events (user_id) VALUES ($1)',
          [user.id]
        );
      } catch (auditError) {
        console.error('Journal connexion indisponible :', auditError.message);
      }
      return res.json({ ok: true, phone: user.phone });
    } catch (err) {
      console.error('Erreur connexion :', err.message, err.code, err.stack);
      return res.status(500).json({
        error: 'Connexion momentanément impossible.'
      });
    }
  }));

  app.get('/api/me', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({
      authenticated: true,
      id: req.user.id,
      phone: req.user.phone,
      role: req.user.role
    });
  });

  app.get('/api/admin/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const result = await query(`
        SELECT
          u.id, u.phone, u.role, u.suspended, u.created_at,
          COALESCE(d.free_used, 0) AS free_used,
          COALESCE(d.rewarded_used, 0) AS rewarded_used,
          (SELECT MAX(le.logged_in_at)
             FROM login_events le WHERE le.user_id = u.id) AS last_login_at,
          (SELECT COUNT(*) FROM login_events le WHERE le.user_id = u.id) AS login_count,
          (SELECT COUNT(*) FROM analysis_events ae WHERE ae.user_id = u.id) AS analysis_count
        FROM users u
        LEFT JOIN daily_usage d
          ON d.user_id = u.id AND d.usage_date = $1
        ORDER BY u.id ASC
      `, [day]);

      res.set('Cache-Control', 'no-store');
      return res.json({ users: result.rows });
    } catch (error) {
      console.error('Erreur liste admin :', error.message);
      return res.status(500).json({
        error: 'Impossible de charger les utilisateurs.'
      });
    }
  }));

  app.patch('/api/admin/users/:id/role', requireAuth, requireSuperAdmin,
    asyncRoute(async (req, res) => {
      const targetId = Number(req.params.id);
      const role = req.body?.role;

      if (!Number.isSafeInteger(targetId) || targetId < 1 ||
          !['user', 'admin'].includes(role)) {
        return res.status(400).json({
          error: 'Utilisateur ou rôle invalide.'
        });
      }

      if (targetId === req.user.id && role !== 'admin') {
        return res.status(400).json({
          error: 'Tu ne peux pas retirer ton propre rôle administrateur.'
        });
      }

      try {
        const result = await transaction(async client => {
          const targetResult = await client.query(
            'SELECT id, role FROM users WHERE id = $1 FOR UPDATE',
            [targetId]
          );
          const target = targetResult.rows[0];
          if (!target) return { notFound: true };

          if (target.role === 'admin' && role === 'user') {
            const admins = await client.query(
              "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"
            );
            if (Number(admins.rows[0].count) <= 1) {
              return { lastAdmin: true };
            }
          }

          await client.query(
            'UPDATE users SET role = $1 WHERE id = $2',
            [role, targetId]
          );
          return { ok: true };
        });

        if (result.notFound) {
          return res.status(404).json({ error: 'Utilisateur introuvable.' });
        }
        if (result.lastAdmin) {
          return res.status(400).json({
            error: 'Impossible de retirer le rôle du dernier administrateur.'
          });
        }

        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, id: targetId, role });
      } catch (error) {
        console.error('Erreur modification rôle :', error.message);
        return res.status(500).json({
          error: 'Impossible de modifier le rôle.'
        });
      }
    })
  );

  app.patch('/api/admin/users/:id/status', requireAuth, requireSuperAdmin,
    asyncRoute(async (req, res) => {
      const targetId = Number(req.params.id);
      const value = req.body?.suspended;

      if (!Number.isSafeInteger(targetId) || targetId < 1 ||
          typeof value !== 'boolean') {
        return res.status(400).json({
          error: 'Identifiant ou statut invalide.'
        });
      }
      if (targetId === 1) {
        return res.status(400).json({
          error: 'Le compte super administrateur est protégé.'
        });
      }

      try {
        const result = await query(
          'UPDATE users SET suspended = $1 WHERE id = $2 RETURNING id',
          [value ? 1 : 0, targetId]
        );
        if (!result.rowCount) {
          return res.status(404).json({ error: 'Utilisateur introuvable.' });
        }

        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, id: targetId, suspended: value });
      } catch (error) {
        console.error('Erreur statut compte :', error.message);
        return res.status(500).json({
          error: 'Impossible de modifier le statut du compte.'
        });
      }
    })
  );

  app.delete('/api/admin/users/:id', requireAuth, requireSuperAdmin,
    asyncRoute(async (req, res) => {
      const targetId = Number(req.params.id);

      if (!Number.isSafeInteger(targetId) || targetId < 1) {
        return res.status(400).json({ error: 'Identifiant invalide.' });
      }
      if (targetId === 1) {
        return res.status(400).json({
          error: 'Le compte super administrateur ne peut pas être supprimé.'
        });
      }

      try {
        const result = await query(
          'DELETE FROM users WHERE id = $1',
          [targetId]
        );
        if (!result.rowCount) {
          return res.status(404).json({ error: 'Utilisateur introuvable.' });
        }

        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, id: targetId, deleted: true });
      } catch (error) {
        console.error('Erreur suppression compte :', error.message);
        return res.status(500).json({ error: 'Suppression impossible.' });
      }
    })
  );

  app.post('/api/logout', (req, res) => {
    clearSession(res);
    return res.json({ ok: true });
  });

  app.get('/api/admin/stats', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    try {
      const usersResult = await query(`
        SELECT
          COUNT(*) AS total_users,
          COUNT(*) FILTER (WHERE role = 'admin') AS admins,
          COUNT(*) FILTER (WHERE role = 'user') AS regular_users
        FROM users
      `);

      const analysesResult = await query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'success') AS successful,
          COUNT(*) FILTER (WHERE status = 'error') AS failed,
          COUNT(*) FILTER (
            WHERE started_at >=
              (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
               || 'T00:00:00Z')
          ) AS today
        FROM analysis_events
      `);

      const activeResult = await query(`
        SELECT COUNT(DISTINCT user_id) AS count
        FROM login_events
        WHERE logged_in_at >= to_char(
          (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '7 days',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      `);

      const users = usersResult.rows[0];
      const analyses = analysesResult.rows[0];
      res.set('Cache-Control', 'no-store');
      return res.json({
        users: {
          total: Number(users.total_users || 0),
          admins: Number(users.admins || 0),
          regular: Number(users.regular_users || 0)
        },
        analyses: {
          total: Number(analyses.total || 0),
          successful: Number(analyses.successful || 0),
          failed: Number(analyses.failed || 0),
          today: Number(analyses.today || 0)
        },
        activeUsers7Days: Number(activeResult.rows[0].count || 0)
      });
    } catch (error) {
      console.error('Erreur statistiques admin :', error.message);
      return res.status(500).json({
        error: 'Impossible de charger les statistiques.'
      });
    }
  }));

  app.get('/api/admin/logins', requireAuth, requireAdmin,
    asyncRoute(async (req, res) => {
      try {
        const result = await query(`
          SELECT le.id, le.user_id, u.phone, u.role, le.logged_in_at
          FROM login_events le
          JOIN users u ON u.id = le.user_id
          ORDER BY le.logged_in_at DESC
          LIMIT 200
        `);
        res.set('Cache-Control', 'no-store');
        return res.json({ events: result.rows });
      } catch (error) {
        console.error('Erreur historique connexion :', error.message);
        return res.status(500).json({
          error: 'Impossible de charger les connexions.'
        });
      }
    })
  );

  app.get('/api/admin/analyses', requireAuth, requireAdmin,
    asyncRoute(async (req, res) => {
      try {
        const result = await query(`
          SELECT ae.id, ae.user_id, u.phone, u.role,
                 ae.match_text, ae.competition, ae.match_date,
                 ae.status, ae.started_at, ae.completed_at
          FROM analysis_events ae
          JOIN users u ON u.id = ae.user_id
          ORDER BY ae.started_at DESC
          LIMIT 200
        `);
        res.set('Cache-Control', 'no-store');
        return res.json({ events: result.rows });
      } catch (error) {
        console.error('Erreur historique analyses :', error.message);
        return res.status(500).json({
          error: 'Impossible de charger les analyses.'
        });
      }
    })
  );


  // Simulation de récompense : ce mécanisme n'atteste pas le visionnage d'une publicité réelle.
  const rewardSimulationLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de tentatives. Réessaie dans une minute.' }
  });

  app.post('/api/reward-simulation/start', requireAuth, rewardSimulationLimiter,
    asyncRoute(async (req, res) => {
      if (req.user.role === 'admin') {
        return res.json({ ok: true, simulation: true, alreadyRewarded: true });
      }

      const userId = req.user.id;
      const day = new Date().toISOString().slice(0, 10);

      const result = await transaction(async client => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS reward_simulation_daily (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reward_date DATE NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            claimed_at TIMESTAMPTZ,
            PRIMARY KEY (user_id, reward_date)
          )
        `);

        await client.query(`
          ALTER TABLE reward_simulation_daily
          ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        `);

        const existing = await client.query(`
          SELECT claimed_at FROM reward_simulation_daily
          WHERE user_id = $1 AND reward_date = $2
          FOR UPDATE
        `, [userId, day]);

        if (existing.rows[0]?.claimed_at) return { alreadyRewarded: true };

        await client.query(`
          INSERT INTO reward_simulation_daily (user_id, reward_date, started_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id, reward_date)
          DO UPDATE SET started_at = NOW()
          WHERE reward_simulation_daily.claimed_at IS NULL
        `, [userId, day]);

        return { alreadyRewarded: false };
      });

      res.set('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        simulation: true,
        alreadyRewarded: result.alreadyRewarded,
        durationSeconds: 5,
        message: 'Simulation de récompense uniquement.'
      });
    })
  );

  app.post('/api/reward-simulation/claim', requireAuth, rewardSimulationLimiter,
    asyncRoute(async (req, res) => {
      if (req.user.role === 'admin') {
        return res.json({ ok: true, simulation: true, credits: 0 });
      }

      const userId = req.user.id;
      const day = new Date().toISOString().slice(0, 10);

      const result = await transaction(async client => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS reward_simulation_daily (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reward_date DATE NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            claimed_at TIMESTAMPTZ,
            PRIMARY KEY (user_id, reward_date)
          )
        `);

        await client.query(`
          ALTER TABLE reward_simulation_daily
          ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        `);

        const ticket = await client.query(`
          SELECT started_at, claimed_at FROM reward_simulation_daily
          WHERE user_id = $1 AND reward_date = $2
          FOR UPDATE
        `, [userId, day]);

        if (!ticket.rows.length) return { status: 'not_started' };
        if (ticket.rows[0].claimed_at) return { status: 'already_claimed' };

        const elapsedMs = Date.now() - new Date(ticket.rows[0].started_at).getTime();
        if (!Number.isFinite(elapsedMs) || elapsedMs < 5000) {
          return { status: 'too_early' };
        }

        await client.query(`
          UPDATE reward_simulation_daily
          SET claimed_at = NOW()
          WHERE user_id = $1 AND reward_date = $2
        `, [userId, day]);

        await client.query(`
          INSERT INTO reward_credits (user_id, credits)
          VALUES ($1, 1)
          ON CONFLICT (user_id)
          DO UPDATE SET credits = reward_credits.credits + 1
        `, [userId]);

        return { status: 'claimed' };
      });

      res.set('Cache-Control', 'no-store');

      if (result.status === 'not_started') {
        return res.status(400).json({ error: 'Aucune simulation démarrée.' });
      }
      if (result.status === 'already_claimed') {
        return res.status(409).json({ error: 'La récompense simulée du jour a déjà été réclamée.' });
      }
      if (result.status === 'too_early') {
        return res.status(429).json({ error: 'Attends la fin des 5 secondes avant de réclamer le crédit.' });
      }

      return res.json({
        ok: true,
        simulation: true,
        credits: 1,
        message: 'Crédit de démonstration ajouté.'
      });
    })
  );

  return requireAuth;
}

module.exports = {
  attachAuth,
  enforceDailyQuota,
  recordAnalysisStart,
  finishAnalysisEvent
};
