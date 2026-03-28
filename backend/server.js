const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const sodium = require('libsodium-wrappers');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const API_KEYS_FILE = path.join(DATA_DIR, 'api_keys.json');
const VIDEOS_CACHE_FILE = path.join(DATA_DIR, 'videos_cache.json');
const IG_CACHE_FILE = path.join(DATA_DIR, 'ig_cache.json');
const SCHEDULED_POSTS_FILE = path.join(DATA_DIR, 'scheduled_posts.json');

// ─── Data Helpers ────────────────────────────────────────────────────────────

async function initializeData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const defaults = [
            [ACCOUNTS_FILE, []],
            [API_KEYS_FILE, { youtube: '', instagram: { appId: '', appSecret: '' }, cloudinary: { cloudName: '', uploadPreset: '' }, github: { token: '', repo: '', branch: 'main' } }],
            [VIDEOS_CACHE_FILE, {}],
            [IG_CACHE_FILE, {}],
            [SCHEDULED_POSTS_FILE, []],
        ];
        for (const [file, defaultData] of defaults) {
            try {
                await fs.access(file);
            } catch {
                await fs.writeFile(file, JSON.stringify(defaultData, null, 2));
            }
        }
        console.log('Data files initialized');
    } catch (err) {
        console.error('Init error:', err);
    }
}

async function readJSON(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
        return null;
    }
}

async function writeJSON(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch {
        return false;
    }
}

// ─── GitHub Sync (for GitHub Actions scheduling) ─────────────────────────────

// Push a single file to GitHub (create or update). Returns true on success.
async function pushFileToGitHub(gh, repoPath, jsonData, commitMessage) {
    const repo = gh.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    const branch = gh.branch || 'main';
    const content = Buffer.from(JSON.stringify(jsonData, null, 2)).toString('base64');
    const headers = { Authorization: `token ${gh.token}`, 'Content-Type': 'application/json', 'User-Agent': 'SocialMediaDashboard' };

    // Fetch current SHA so GitHub accepts the update
    let sha;
    try {
        const r = await fetch(`https://api.github.com/repos/${repo}/contents/${repoPath}?ref=${branch}`, { headers });
        if (r.ok) sha = (await r.json()).sha;
    } catch { }

    const body = { message: commitMessage, content, branch };
    if (sha) body.sha = sha;

    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${repoPath}`, {
        method: 'PUT', headers, body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(`GitHub PUT ${repoPath}: ${err.message}`);
    }
    return true;
}

// Sync ALL data files to GitHub in one pass.
// accounts.json is pushed with accessToken stripped (tokens stay in the encrypted secret).
async function syncAllDataToGitHub() {
    try {
        const keys = await readJSON(API_KEYS_FILE) || {};
        const gh = keys.github;
        if (!gh?.token || !gh?.repo) return;

        const [posts, rawAccounts] = await Promise.all([
            readJSON(SCHEDULED_POSTS_FILE) || [],
            readJSON(ACCOUNTS_FILE) || [],
        ]);

        // Strip sensitive token fields before committing accounts to a public/private repo
        const safeAccounts = rawAccounts.map(a => {
            const copy = { ...a };
            delete copy.accessToken;
            return copy;
        });

        const files = [
            { path: 'backend/data/scheduled_posts.json', data: posts,        label: 'scheduled posts' },
            { path: 'backend/data/accounts.json',        data: safeAccounts, label: 'accounts'        },
        ];

        const results = await Promise.allSettled(
            files.map(f => pushFileToGitHub(gh, f.path, f.data, `☁️ Sync ${f.label}`))
        );

        results.forEach((r, i) => {
            if (r.status === 'fulfilled') console.log(`  ☁️ Synced ${files[i].label} to GitHub`);
            else console.error(`  ☁️ GitHub sync error (${files[i].label}):`, r.reason?.message);
        });
    } catch (err) {
        console.error('  ☁️ syncAllDataToGitHub error:', err.message);
    }
}


async function pullScheduledPostsFromGitHub() {
    try {
        const keys = await readJSON(API_KEYS_FILE) || {};
        const gh = keys.github;
        if (!gh?.token || !gh?.repo) return;

        // Normalize repo: accept full URL or owner/repo format
        const repo = gh.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');

        const filePath = 'backend/data/scheduled_posts.json';
        const branch = gh.branch || 'main';

        const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`, {
            headers: { Authorization: `token ${gh.token}`, 'User-Agent': 'SocialMediaDashboard' }
        });
        if (!res.ok) return;

        const data = await res.json();
        const remotePosts = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
        const localPosts = await readJSON(SCHEDULED_POSTS_FILE) || [];

        // Merge: remote published/failed status wins; local-only posts are kept
        const remoteMap = new Map(remotePosts.map(p => [p.id, p]));
        const localMap = new Map(localPosts.map(p => [p.id, p]));
        const merged = [];

        for (const rp of remotePosts) {
            const lp = localMap.get(rp.id);
            if (!lp || rp.status === 'published' || rp.status === 'failed') {
                merged.push(rp); // Remote version takes precedence for terminal states
            } else {
                merged.push(lp); // Local is more current otherwise
            }
        }
        // Add local-only posts (created while server was off & GH Actions hasn't synced)
        for (const lp of localPosts) {
            if (!remoteMap.has(lp.id)) merged.push(lp);
        }

        await writeJSON(SCHEDULED_POSTS_FILE, merged);
        console.log(`  ☁️ Pulled ${remotePosts.length} post(s) from GitHub, merged to ${merged.length}`);
    } catch (err) {
        console.error('  ☁️ GitHub pull error:', err.message);
    }
}

// ─── GitHub Accounts Secret Sync ─────────────────────────────────────────────
// Automatically updates ACCOUNTS_JSON secret in GitHub Actions whenever accounts change.
// This means you never have to manually regenerate the base64 secret again.

async function syncAccountsSecretToGitHub() {
    try {
        const keys = await readJSON(API_KEYS_FILE) || {};
        const gh = keys.github;
        if (!gh?.token || !gh?.repo) return;

        const repo = gh.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
        const accounts = await readJSON(ACCOUNTS_FILE) || [];
        const secretValue = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');

        // Step 1: Get the repo's public key for encrypting secrets
        const pkRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
            headers: { Authorization: `token ${gh.token}`, 'User-Agent': 'SocialMediaDashboard' }
        });
        if (!pkRes.ok) {
            console.error('  ☁️ Failed to get GitHub public key:', (await pkRes.json()).message);
            return;
        }
        const { key: publicKey, key_id } = await pkRes.json();

        // Step 2: Encrypt the secret using libsodium sealed box
        await sodium.ready;
        const binKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
        const binSecret = sodium.from_string(secretValue);
        const encrypted = sodium.crypto_box_seal(binSecret, binKey);
        const encryptedB64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

        // Step 3: Update the secret
        const res = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/ACCOUNTS_JSON`, {
            method: 'PUT',
            headers: {
                Authorization: `token ${gh.token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'SocialMediaDashboard'
            },
            body: JSON.stringify({ encrypted_value: encryptedB64, key_id }),
        });

        if (res.status === 201 || res.status === 204) {
            console.log('  ☁️ Synced ACCOUNTS_JSON secret to GitHub');
        } else {
            const err = await res.json();
            console.error('  ☁️ GitHub secret sync error:', err.message);
        }
    } catch (err) {
        console.error('  ☁️ GitHub secret sync error:', err.message);
    }
}

// Push all data files + refresh encrypted secret in one shot.
// Use this everywhere instead of calling the two functions separately.
async function syncEverythingToGitHub() {
    await Promise.allSettled([syncAllDataToGitHub(), syncAccountsSecretToGitHub()]);
}

async function getAPIKey() {
    const keys = await readJSON(API_KEYS_FILE);
    return keys?.youtube || '';
}

async function getIGAppCredentials() {
    const keys = await readJSON(API_KEYS_FILE);
    return keys?.instagram || { appId: '', appSecret: '' };
}

// ─── Instagram Graph API Helpers (Instagram API with Instagram Login) ────────
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
// Uses graph.instagram.com (NOT graph.facebook.com)
// Instagram App ID & App Secret come from App Dashboard > Instagram > API setup

const IG_GRAPH_URL = 'https://graph.instagram.com';
const IG_API_VERSION = 'v25.0';

async function igFetch(endpoint, params = {}) {
    // Endpoints that start with /oauth, /access_token, /refresh_access_token are unversioned
    const needsVersion = !endpoint.startsWith('/oauth') &&
        !endpoint.startsWith('/access_token') &&
        !endpoint.startsWith('/refresh_access_token');
    const base = needsVersion ? `${IG_GRAPH_URL}/${IG_API_VERSION}` : IG_GRAPH_URL;
    const url = new URL(`${base}${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || data.error.error_message || JSON.stringify(data.error));
    if (data.error_message) throw new Error(data.error_message);
    return data;
}

// Exchange a short-lived Instagram token for a long-lived one (~60 days)
// Endpoint: GET https://graph.instagram.com/access_token
async function exchangeForLongLivedToken(shortToken, appSecret) {
    const data = await igFetch('/access_token', {
        grant_type: 'ig_exchange_token',
        client_secret: appSecret,
        access_token: shortToken,
    });
    if (!data.access_token) throw new Error('Failed to exchange token — check Instagram App Secret');
    return {
        accessToken: data.access_token,
        tokenType: data.token_type || 'bearer',
        expiresIn: data.expires_in || 5184000, // ~60 days
    };
}

// Auto-refresh Instagram long-lived tokens that expire within 15 days
async function autoRefreshInstagramTokens() {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE) || [];
        const igAccounts = accounts.filter(a => a.platform === 'instagram' && a.accessToken && a.tokenExpiresAt);
        if (igAccounts.length === 0) return;

        const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
        const soon = new Date(Date.now() + fifteenDaysMs);
        const toRefresh = igAccounts.filter(a => new Date(a.tokenExpiresAt) <= soon);

        if (toRefresh.length === 0) return;

        console.log(`\n  🔑 Auto-refreshing ${toRefresh.length} Instagram token(s) expiring within 15 days...`);
        let changed = false;
        for (const account of toRefresh) {
            try {
                const refreshed = await refreshLongLivedToken(account.accessToken);
                account.accessToken = refreshed.accessToken;
                account.tokenExpiresAt = new Date(Date.now() + (refreshed.expiresIn || 5184000) * 1000).toISOString();
                console.log(`  ✅ Token refreshed for @${account.username} — expires ${account.tokenExpiresAt}`);
                changed = true;
            } catch (err) {
                console.error(`  ❌ Failed to refresh token for @${account.username}: ${err.message}`);
            }
        }

        if (changed) {
            await writeJSON(ACCOUNTS_FILE, accounts);
            syncEverythingToGitHub().catch(() => { });
        }
    } catch (err) {
        console.error('  ❌ autoRefreshInstagramTokens error:', err.message);
    }
}

// Refresh a long-lived token for another 60 days
// Endpoint: GET https://graph.instagram.com/refresh_access_token
async function refreshLongLivedToken(longToken) {
    const data = await igFetch('/refresh_access_token', {
        grant_type: 'ig_refresh_token',
        access_token: longToken,
    });
    if (!data.access_token) throw new Error('Failed to refresh token');
    return {
        accessToken: data.access_token,
        tokenType: data.token_type || 'bearer',
        expiresIn: data.expires_in || 5184000,
    };
}

// Get the Instagram user ID & profile using /me (no Facebook Pages needed)
async function fetchInstagramProfile(igUserId, accessToken) {
    // If no igUserId provided, use /me to discover it
    const endpoint = igUserId ? `/${igUserId}` : '/me';
    const data = await igFetch(endpoint, {
        access_token: accessToken,
        fields: 'user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website',
    });
    return {
        igUserId: data.user_id || data.id || igUserId,
        name: data.name || '',
        username: data.username || '',
        profilePictureUrl: data.profile_picture_url || '',
        followersCount: data.followers_count || 0,
        followsCount: data.follows_count || 0,
        mediaCount: data.media_count || 0,
        biography: data.biography || '',
        website: data.website || '',
    };
}

async function fetchInstagramMedia(igUserId, accessToken, limit = 500) {
    let allMedia = [];
    // Use the versioned IG Graph API for media — fetch up to 100 per page, paginate up to 10 pages
    let url = `${IG_GRAPH_URL}/${IG_API_VERSION}/${igUserId}/media?access_token=${accessToken}&fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=${Math.min(limit, 100)}`;

    let pages = 0;
    while (url && pages < 10 && allMedia.length < limit) {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || data.error.error_message);
        if (data.data) allMedia = allMedia.concat(data.data);
        url = data.paging?.next || null;
        pages++;
    }

    return allMedia.slice(0, limit).map(m => ({
        id: m.id,
        caption: m.caption || '',
        mediaType: m.media_type || 'IMAGE',
        mediaUrl: m.media_url || '',
        thumbnailUrl: m.thumbnail_url || m.media_url || '',
        permalink: m.permalink || '',
        timestamp: m.timestamp || '',
        likeCount: m.like_count || 0,
        commentsCount: m.comments_count || 0,
    }));
}

function computeInstagramAnalytics(profile, media) {
    const emptyAnalytics = {
        totalPosts: profile.mediaCount || 0, fetchedPosts: 0,
        totalLikes: 0, totalComments: 0, totalEngagement: 0,
        avgLikes: 0, avgComments: 0, avgEngagement: 0,
        medianLikes: 0, medianComments: 0,
        engagementRate: 0, likesPerFollower: 0, commentsPerFollower: 0,
        bestByLikes: null, bestByComments: null, worstByLikes: null,
        recentMedia: [], mediaTypeDistribution: {},
        postFrequency: { perWeek: 0, perMonth: 0 },
        topPosts: [], performanceByType: {},
        hashtagAnalysis: [], captionLengthCorrelation: [],
        postsByDayOfWeek: [], postsByHour: [],
        engagementTimeline: [], monthlyBreakdown: [],
        postsLast7Days: 0, postsLast30Days: 0, postsLast90Days: 0,
        viralityScore: 0, consistencyScore: 0,
        bestPostingDay: '', bestPostingHour: '',
        likesToCommentsRatio: 0,
    };
    if (!media || media.length === 0) return emptyAnalytics;

    const totalLikes = media.reduce((s, m) => s + m.likeCount, 0);
    const totalComments = media.reduce((s, m) => s + m.commentsCount, 0);
    const totalEngagement = totalLikes + totalComments;
    const avgLikes = Math.round(totalLikes / media.length);
    const avgComments = Math.round(totalComments / media.length);
    const avgEngagement = Math.round(totalEngagement / media.length);
    const engagementRate = profile.followersCount > 0
        ? parseFloat(((totalLikes + totalComments) / media.length / profile.followersCount * 100).toFixed(2))
        : 0;
    const likesPerFollower = profile.followersCount > 0
        ? parseFloat((totalLikes / media.length / profile.followersCount * 100).toFixed(2)) : 0;
    const commentsPerFollower = profile.followersCount > 0
        ? parseFloat((totalComments / media.length / profile.followersCount * 100).toFixed(2)) : 0;

    // Median
    const sortedLikes = [...media].map(m => m.likeCount).sort((a, b) => a - b);
    const sortedComments = [...media].map(m => m.commentsCount).sort((a, b) => a - b);
    const mid = Math.floor(sortedLikes.length / 2);
    const medianLikes = sortedLikes.length % 2 ? sortedLikes[mid] : Math.round((sortedLikes[mid - 1] + sortedLikes[mid]) / 2);
    const medianComments = sortedComments.length % 2 ? sortedComments[mid] : Math.round((sortedComments[mid - 1] + sortedComments[mid]) / 2);

    const byLikes = [...media].sort((a, b) => b.likeCount - a.likeCount);
    const byComments = [...media].sort((a, b) => b.commentsCount - a.commentsCount);
    const likesToCommentsRatio = totalComments > 0 ? parseFloat((totalLikes / totalComments).toFixed(1)) : 0;

    // Media type distribution + performance by type
    const mediaTypes = {};
    const typeStats = {};
    media.forEach(m => {
        const t = m.mediaType;
        mediaTypes[t] = (mediaTypes[t] || 0) + 1;
        if (!typeStats[t]) typeStats[t] = { likes: 0, comments: 0, count: 0 };
        typeStats[t].likes += m.likeCount;
        typeStats[t].comments += m.commentsCount;
        typeStats[t].count++;
    });
    const performanceByType = {};
    Object.entries(typeStats).forEach(([type, s]) => {
        performanceByType[type] = {
            count: s.count,
            avgLikes: Math.round(s.likes / s.count),
            avgComments: Math.round(s.comments / s.count),
            avgEngagement: Math.round((s.likes + s.comments) / s.count),
            totalLikes: s.likes,
            totalComments: s.comments,
        };
    });

    // Post frequency
    const dates = media.map(m => new Date(m.timestamp)).filter(d => !isNaN(d));
    let perWeek = 0, perMonth = 0;
    if (dates.length >= 2) {
        const newest = Math.max(...dates);
        const oldest = Math.min(...dates);
        const spanDays = Math.max(1, (newest - oldest) / 86400000);
        perWeek = parseFloat((media.length / spanDays * 7).toFixed(1));
        perMonth = parseFloat((media.length / spanDays * 30).toFixed(1));
    }

    // Posts by day of week
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayBuckets = Array(7).fill(null).map(() => ({ count: 0, likes: 0, comments: 0 }));
    dates.forEach((d, i) => {
        const day = d.getDay();
        dayBuckets[day].count++;
        dayBuckets[day].likes += media[i]?.likeCount || 0;
        dayBuckets[day].comments += media[i]?.commentsCount || 0;
    });
    const postsByDayOfWeek = dayBuckets.map((b, i) => ({
        day: dayNames[i], shortDay: dayNames[i].slice(0, 3),
        posts: b.count,
        avgLikes: b.count > 0 ? Math.round(b.likes / b.count) : 0,
        avgComments: b.count > 0 ? Math.round(b.comments / b.count) : 0,
        avgEngagement: b.count > 0 ? Math.round((b.likes + b.comments) / b.count) : 0,
    }));
    const bestDayObj = postsByDayOfWeek.reduce((best, d) => d.avgEngagement > best.avgEngagement ? d : best, postsByDayOfWeek[0]);
    const bestPostingDay = bestDayObj?.day || '';

    // Posts by hour
    const hourBuckets = Array(24).fill(null).map(() => ({ count: 0, likes: 0, comments: 0 }));
    dates.forEach((d, i) => {
        const h = d.getHours();
        hourBuckets[h].count++;
        hourBuckets[h].likes += media[i]?.likeCount || 0;
        hourBuckets[h].comments += media[i]?.commentsCount || 0;
    });
    const postsByHour = hourBuckets.map((b, i) => ({
        hour: i, label: `${i}:00`,
        posts: b.count,
        avgEngagement: b.count > 0 ? Math.round((b.likes + b.comments) / b.count) : 0,
    }));
    const bestHourObj = postsByHour.reduce((best, h) => h.avgEngagement > best.avgEngagement ? h : best, postsByHour[0]);
    const bestPostingHour = bestHourObj?.posts > 0 ? bestHourObj.label : '';

    // Monthly breakdown / engagement timeline
    const monthMap = {};
    media.forEach(m => {
        const d = new Date(m.timestamp);
        if (isNaN(d)) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthMap[key]) monthMap[key] = { posts: 0, likes: 0, comments: 0 };
        monthMap[key].posts++;
        monthMap[key].likes += m.likeCount;
        monthMap[key].comments += m.commentsCount;
    });
    const monthlyBreakdown = Object.entries(monthMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, s]) => ({
            month,
            posts: s.posts,
            likes: s.likes, comments: s.comments,
            avgLikes: Math.round(s.likes / s.posts),
            avgComments: Math.round(s.comments / s.posts),
            engagement: s.likes + s.comments,
        }));
    const engagementTimeline = monthlyBreakdown; // alias

    // Recent activity
    const now = Date.now();
    const postsLast7Days = dates.filter(d => (now - d.getTime()) <= 7 * 86400000).length;
    const postsLast30Days = dates.filter(d => (now - d.getTime()) <= 30 * 86400000).length;
    const postsLast90Days = dates.filter(d => (now - d.getTime()) <= 90 * 86400000).length;

    // Hashtag analysis
    const hashtagMap = {};
    media.forEach(m => {
        const tags = (m.caption || '').match(/#[\w\u00C0-\u024F]+/g) || [];
        tags.forEach(tag => {
            const t = tag.toLowerCase();
            if (!hashtagMap[t]) hashtagMap[t] = { tag: t, count: 0, likes: 0, comments: 0 };
            hashtagMap[t].count++;
            hashtagMap[t].likes += m.likeCount;
            hashtagMap[t].comments += m.commentsCount;
        });
    });
    const hashtagAnalysis = Object.values(hashtagMap)
        .map(h => ({ ...h, avgEngagement: Math.round((h.likes + h.comments) / h.count) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

    // Caption length correlation
    const captionBuckets = [
        { label: 'No caption', min: 0, max: 0 },
        { label: 'Short (1-50)', min: 1, max: 50 },
        { label: 'Medium (51-150)', min: 51, max: 150 },
        { label: 'Long (151-300)', min: 151, max: 300 },
        { label: 'Very Long (300+)', min: 301, max: Infinity },
    ];
    const captionLengthCorrelation = captionBuckets.map(bucket => {
        const posts = media.filter(m => {
            const len = (m.caption || '').length;
            return len >= bucket.min && len <= bucket.max;
        });
        return {
            label: bucket.label, count: posts.length,
            avgLikes: posts.length > 0 ? Math.round(posts.reduce((s, m) => s + m.likeCount, 0) / posts.length) : 0,
            avgComments: posts.length > 0 ? Math.round(posts.reduce((s, m) => s + m.commentsCount, 0) / posts.length) : 0,
            avgEngagement: posts.length > 0 ? Math.round(posts.reduce((s, m) => s + m.likeCount + m.commentsCount, 0) / posts.length) : 0,
        };
    }).filter(b => b.count > 0);

    // Top + worst posts
    const topPosts = [...media]
        .map(m => ({ ...m, engagement: m.likeCount + m.commentsCount }))
        .sort((a, b) => b.engagement - a.engagement)
        .slice(0, 10);
    const worstByLikes = byLikes.length > 0 ? byLikes[byLikes.length - 1] : null;

    // Virality score (best / avg)
    const bestEngagement = topPosts[0] ? topPosts[0].engagement : 0;
    const viralityScore = avgEngagement > 0 ? parseFloat((bestEngagement / avgEngagement).toFixed(1)) : 0;

    // Consistency score (0-100) based on std deviation of engagement
    let consistencyScore = 0;
    if (media.length >= 3) {
        const engagements = media.map(m => m.likeCount + m.commentsCount);
        const mean = engagements.reduce((s, v) => s + v, 0) / engagements.length;
        const variance = engagements.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / engagements.length;
        const stdDev = Math.sqrt(variance);
        const cv = mean > 0 ? stdDev / mean : 1; // coefficient of variation
        consistencyScore = Math.max(0, Math.min(100, Math.round((1 - Math.min(cv, 1)) * 100)));
    }

    return {
        totalPosts: profile.mediaCount || media.length,
        fetchedPosts: media.length,
        totalLikes, totalComments, totalEngagement,
        avgLikes, avgComments, avgEngagement,
        medianLikes, medianComments,
        engagementRate, likesPerFollower, commentsPerFollower,
        likesToCommentsRatio,
        bestByLikes: byLikes[0] || null,
        bestByComments: byComments[0] || null,
        worstByLikes,
        recentMedia: media.slice(0, 20),
        mediaTypeDistribution: mediaTypes,
        performanceByType,
        postFrequency: { perWeek, perMonth },
        topPosts,
        postsByDayOfWeek, bestPostingDay,
        postsByHour, bestPostingHour,
        engagementTimeline, monthlyBreakdown,
        postsLast7Days, postsLast30Days, postsLast90Days,
        hashtagAnalysis,
        captionLengthCorrelation,
        viralityScore, consistencyScore,
    };
}

// ─── YouTube API Helpers ─────────────────────────────────────────────────────

async function ytFetch(endpoint, params, apiKey) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    params.key = apiKey;
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data;
}

function extractChannelId(input) {
    if (!input) return null;
    input = input.trim();
    // Direct channel ID
    if (/^UC[\w-]{22}$/.test(input)) return input;
    // URL patterns
    const patterns = [
        /youtube\.com\/channel\/(UC[\w-]{22})/,
        /youtube\.com\/@([\w.-]+)/,
        /youtube\.com\/c\/([\w.-]+)/,
        /youtube\.com\/user\/([\w.-]+)/,
        /youtube\.com\/([\w.-]+)/,
    ];
    for (const p of patterns) {
        const m = input.match(p);
        if (m) return m[1];
    }
    return input;
}

async function resolveChannelId(input, apiKey) {
    const extracted = extractChannelId(input);
    if (!extracted) throw new Error('Invalid input');

    // If it's already a channel ID
    if (/^UC[\w-]{22}$/.test(extracted)) return extracted;

    // Try as custom URL / username / handle
    // Search for channel by handle
    try {
        const data = await ytFetch('channels', { part: 'id', forHandle: extracted }, apiKey);
        if (data.items && data.items.length > 0) return data.items[0].id;
    } catch { }

    try {
        const data = await ytFetch('channels', { part: 'id', forUsername: extracted }, apiKey);
        if (data.items && data.items.length > 0) return data.items[0].id;
    } catch { }

    // Search as last resort
    try {
        const data = await ytFetch('search', { part: 'snippet', q: extracted, type: 'channel', maxResults: '1' }, apiKey);
        if (data.items && data.items.length > 0) return data.items[0].snippet.channelId;
    } catch { }

    throw new Error('Could not resolve channel. Please provide a valid Channel ID (starts with UC).');
}

async function fetchChannelData(channelId, apiKey) {
    const data = await ytFetch('channels', {
        part: 'snippet,statistics,contentDetails,brandingSettings,status,topicDetails',
        id: channelId,
    }, apiKey);

    if (!data.items || data.items.length === 0) throw new Error('Channel not found');
    const ch = data.items[0];

    return {
        channelId: ch.id,
        title: ch.snippet.title,
        description: ch.snippet.description,
        customUrl: ch.snippet.customUrl || '',
        publishedAt: ch.snippet.publishedAt,
        country: ch.snippet.country || 'Unknown',
        thumbnails: {
            default: ch.snippet.thumbnails?.default?.url || '',
            medium: ch.snippet.thumbnails?.medium?.url || '',
            high: ch.snippet.thumbnails?.high?.url || '',
        },
        subscriberCount: parseInt(ch.statistics.subscriberCount) || 0,
        viewCount: parseInt(ch.statistics.viewCount) || 0,
        videoCount: parseInt(ch.statistics.videoCount) || 0,
        hiddenSubscriberCount: ch.statistics.hiddenSubscriberCount || false,
        uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads || '',
        keywords: ch.brandingSettings?.channel?.keywords || '',
        bannerUrl: ch.brandingSettings?.image?.bannerExternalUrl || '',
        madeForKids: ch.status?.madeForKids || false,
        topicCategories: ch.topicDetails?.topicCategories || [],
        isLinked: ch.status?.isLinked || false,
    };
}

async function fetchAllVideos(playlistId, apiKey, maxPages = 10) {
    let allVideos = [];
    let pageToken = '';
    let page = 0;

    while (page < maxPages) {
        const params = {
            part: 'snippet,contentDetails',
            playlistId,
            maxResults: '50',
        };
        if (pageToken) params.pageToken = pageToken;

        const data = await ytFetch('playlistItems', params, apiKey);
        if (!data.items || data.items.length === 0) break;

        const videoIds = data.items.map(i => i.snippet.resourceId.videoId).join(',');

        // Fetch detailed video stats
        const statsData = await ytFetch('videos', {
            part: 'statistics,contentDetails,snippet,status',
            id: videoIds,
        }, apiKey);

        if (statsData.items) {
            allVideos = allVideos.concat(statsData.items.map(v => ({
                videoId: v.id,
                title: v.snippet.title,
                description: v.snippet.description?.substring(0, 200) || '',
                publishedAt: v.snippet.publishedAt,
                channelTitle: v.snippet.channelTitle,
                thumbnails: {
                    default: v.snippet.thumbnails?.default?.url || '',
                    medium: v.snippet.thumbnails?.medium?.url || '',
                    high: v.snippet.thumbnails?.high?.url || '',
                },
                tags: v.snippet.tags || [],
                categoryId: v.snippet.categoryId || '',
                liveBroadcastContent: v.snippet.liveBroadcastContent || 'none',
                defaultAudioLanguage: v.snippet.defaultAudioLanguage || '',
                duration: v.contentDetails.duration,
                dimension: v.contentDetails.dimension || '2d',
                definition: v.contentDetails.definition || 'hd',
                caption: v.contentDetails.caption === 'true',
                licensedContent: v.contentDetails.licensedContent || false,
                projection: v.contentDetails.projection || 'rectangular',
                viewCount: parseInt(v.statistics.viewCount) || 0,
                likeCount: parseInt(v.statistics.likeCount) || 0,
                commentCount: parseInt(v.statistics.commentCount) || 0,
                privacyStatus: v.status?.privacyStatus || 'public',
                embeddable: v.status?.embeddable || false,
                madeForKids: v.status?.madeForKids || false,
            })));
        }

        pageToken = data.nextPageToken || '';
        if (!pageToken) break;
        page++;
    }

    return allVideos;
}

function parseDuration(iso) {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

function computeVideoAnalytics(videos) {
    if (!videos || videos.length === 0) {
        return {
            totalVideos: 0, totalViews: 0, totalLikes: 0, totalComments: 0,
            avgViews: 0, avgLikes: 0, avgComments: 0, medianViews: 0,
            totalEngagement: 0, overallEngagementRate: 0,
            avgDurationSeconds: 0, avgDurationFormatted: '0:00',
            totalDurationSeconds: 0, totalDurationFormatted: '0:00',
            bestByViews: null, bestByLikes: null, bestByComments: null,
            bestByEngagement: null, worstByViews: null,
            mostRecent: null, oldest: null,
            top10ByViews: [], top10ByLikes: [], top10ByComments: [], top10ByEngagement: [],
            shortsCount: 0, regularCount: 0,
            avgShortViews: 0, avgRegularViews: 0,
            hdCount: 0, sdCount: 0, hdPercentage: 0,
            captionCount: 0, captionPercentage: 0,
            licensedCount: 0, licensedPercentage: 0,
            madeForKidsCount: 0, embeddableCount: 0,
            publishDayDistribution: {}, publishHourDistribution: {},
            peakPublishDay: '', peakPublishHour: 0,
            durationDistribution: { short: 0, medium: 0, long: 0, veryLong: 0 },
            categoryDistribution: {},
            tagFrequency: [],
            videosLast7Days: 0, videosLast30Days: 0, videosLast90Days: 0, videosLast365Days: 0,
            uploadFrequencyPerWeek: 0, uploadFrequencyPerMonth: 0,
            consistencyScore: 0,
            viralityScore: 0,
            viewsDistribution: { ranges: [], counts: [] },
            engagementTrend: [],
            viewsTrend: [],
            likeRateTrend: [],
        };
    }

    const now = new Date();
    const durations = videos.map(v => parseDuration(v.duration));
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    // Engagement rates — compute FIRST so all sorted arrays have the fields
    const withEngagement = videos.map(v => ({
        ...v,
        engagementRate: v.viewCount > 0 ? ((v.likeCount + v.commentCount) / v.viewCount) * 100 : 0,
        likeRate: v.viewCount > 0 ? (v.likeCount / v.viewCount) * 100 : 0,
        commentRate: v.viewCount > 0 ? (v.commentCount / v.viewCount) * 100 : 0,
        durationSeconds: parseDuration(v.duration),
        daysSinceUpload: Math.max(1, Math.floor((now - new Date(v.publishedAt)) / 86400000)),
    }));
    const viewsSorted = [...withEngagement].sort((a, b) => b.viewCount - a.viewCount);
    const likesSorted = [...withEngagement].sort((a, b) => b.likeCount - a.likeCount);
    const commentsSorted = [...withEngagement].sort((a, b) => b.commentCount - a.commentCount);
    const dateSorted = [...withEngagement].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const engagementSorted = [...withEngagement].sort((a, b) => b.engagementRate - a.engagementRate);

    const totalViews = videos.reduce((s, v) => s + v.viewCount, 0);
    const totalLikes = videos.reduce((s, v) => s + v.likeCount, 0);
    const totalComments = videos.reduce((s, v) => s + v.commentCount, 0);
    const avgViews = Math.round(totalViews / videos.length);
    const avgLikes = Math.round(totalLikes / videos.length);
    const avgComments = Math.round(totalComments / videos.length);

    // Median
    const sortedViews = [...videos].map(v => v.viewCount).sort((a, b) => a - b);
    const mid = Math.floor(sortedViews.length / 2);
    const medianViews = sortedViews.length % 2 ? sortedViews[mid] : Math.round((sortedViews[mid - 1] + sortedViews[mid]) / 2);

    // Shorts vs Regular
    const shorts = withEngagement.filter(v => v.durationSeconds <= 60);
    const regular = withEngagement.filter(v => v.durationSeconds > 60);

    // Duration distribution
    const durationDist = { short: 0, medium: 0, long: 0, veryLong: 0 };
    withEngagement.forEach(v => {
        if (v.durationSeconds <= 60) durationDist.short++;
        else if (v.durationSeconds <= 600) durationDist.medium++;
        else if (v.durationSeconds <= 3600) durationDist.long++;
        else durationDist.veryLong++;
    });

    // HD/SD, captions, licensed, etc.
    const hdCount = videos.filter(v => v.definition === 'hd').length;
    const captionCount = videos.filter(v => v.caption).length;
    const licensedCount = videos.filter(v => v.licensedContent).length;
    const madeForKidsCount = videos.filter(v => v.madeForKids).length;
    const embeddableCount = videos.filter(v => v.embeddable).length;

    // Publish day/hour distribution
    const dayDist = {};
    const hourDist = {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    videos.forEach(v => {
        const d = new Date(v.publishedAt);
        const day = dayNames[d.getUTCDay()];
        const hour = d.getUTCHours();
        dayDist[day] = (dayDist[day] || 0) + 1;
        hourDist[hour] = (hourDist[hour] || 0) + 1;
    });

    const peakDay = Object.entries(dayDist).sort((a, b) => b[1] - a[1])[0];
    const peakHour = Object.entries(hourDist).sort((a, b) => b[1] - a[1])[0];

    // Category distribution
    const catDist = {};
    videos.forEach(v => {
        const cat = v.categoryId || 'Unknown';
        catDist[cat] = (catDist[cat] || 0) + 1;
    });

    // Tag frequency
    const tagMap = {};
    videos.forEach(v => {
        (v.tags || []).forEach(t => {
            const lower = t.toLowerCase();
            tagMap[lower] = (tagMap[lower] || 0) + 1;
        });
    });
    const tagFrequency = Object.entries(tagMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([tag, count]) => ({ tag, count }));

    // Recent videos count
    const msDay = 86400000;
    const videosLast7 = videos.filter(v => (now - new Date(v.publishedAt)) < 7 * msDay).length;
    const videosLast30 = videos.filter(v => (now - new Date(v.publishedAt)) < 30 * msDay).length;
    const videosLast90 = videos.filter(v => (now - new Date(v.publishedAt)) < 90 * msDay).length;
    const videosLast365 = videos.filter(v => (now - new Date(v.publishedAt)) < 365 * msDay).length;

    // Upload frequency
    const oldestDate = new Date(dateSorted[dateSorted.length - 1]?.publishedAt || now);
    const totalWeeks = Math.max(1, (now - oldestDate) / (7 * msDay));
    const totalMonths = Math.max(1, totalWeeks / 4.33);

    // Consistency score (0-100) based on how regular uploads are
    const weeklyUploads = videos.reduce((acc, v) => {
        const weekNum = Math.floor((now - new Date(v.publishedAt)) / (7 * msDay));
        acc[weekNum] = (acc[weekNum] || 0) + 1;
        return acc;
    }, {});
    const weekValues = Object.values(weeklyUploads);
    const avgWeekly = weekValues.reduce((a, b) => a + b, 0) / Math.max(1, weekValues.length);
    const variance = weekValues.reduce((s, v) => s + Math.pow(v - avgWeekly, 2), 0) / Math.max(1, weekValues.length);
    const stdDev = Math.sqrt(variance);
    const consistencyScore = Math.max(0, Math.min(100, Math.round(100 - (stdDev / Math.max(0.01, avgWeekly)) * 25)));

    // Virality score
    const viralityScore = avgViews > 0 ? Math.round((viewsSorted[0]?.viewCount || 0) / avgViews * 10) / 10 : 0;

    // Views distribution for histogram
    const maxViews = viewsSorted[0]?.viewCount || 0;
    const step = Math.max(1, Math.ceil(maxViews / 10));
    const viewsRanges = [];
    const viewsCounts = [];
    for (let i = 0; i < 10; i++) {
        const low = i * step;
        const high = (i + 1) * step;
        viewsRanges.push(`${formatCompact(low)}-${formatCompact(high)}`);
        viewsCounts.push(videos.filter(v => v.viewCount >= low && v.viewCount < high).length);
    }

    // Trends (monthly aggregation for last 12 months)
    const monthlyData = {};
    withEngagement.forEach(v => {
        const d = new Date(v.publishedAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyData[key]) monthlyData[key] = { views: 0, likes: 0, comments: 0, count: 0 };
        monthlyData[key].views += v.viewCount;
        monthlyData[key].likes += v.likeCount;
        monthlyData[key].comments += v.commentCount;
        monthlyData[key].count++;
    });
    const sortedMonths = Object.keys(monthlyData).sort();
    const viewsTrend = sortedMonths.map(m => ({ month: m, value: monthlyData[m].views, count: monthlyData[m].count }));
    const engagementTrend = sortedMonths.map(m => ({
        month: m,
        value: monthlyData[m].views > 0
            ? ((monthlyData[m].likes + monthlyData[m].comments) / monthlyData[m].views * 100).toFixed(2)
            : 0,
    }));
    const likeRateTrend = sortedMonths.map(m => ({
        month: m,
        value: monthlyData[m].views > 0 ? ((monthlyData[m].likes / monthlyData[m].views) * 100).toFixed(2) : 0,
    }));

    const formatVid = (v) => v ? {
        videoId: v.videoId, title: v.title, viewCount: v.viewCount,
        likeCount: v.likeCount, commentCount: v.commentCount,
        publishedAt: v.publishedAt,
        thumbnail: v.thumbnails?.medium || v.thumbnails?.default || '',
        engagementRate: v.engagementRate?.toFixed(2) || 0,
        durationSeconds: v.durationSeconds || parseDuration(v.duration),
    } : null;

    const formatDuration = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return h > 0 ? `${h}h ${m}m` : `${m}m ${sec}s`;
    };

    return {
        totalVideos: videos.length,
        totalViews, totalLikes, totalComments,
        avgViews, avgLikes, avgComments, medianViews,
        totalEngagement: totalLikes + totalComments,
        overallEngagementRate: totalViews > 0 ? ((totalLikes + totalComments) / totalViews * 100).toFixed(2) : 0,
        avgDurationSeconds: Math.round(totalDuration / videos.length),
        avgDurationFormatted: formatDuration(Math.round(totalDuration / videos.length)),
        totalDurationSeconds: totalDuration,
        totalDurationFormatted: formatDuration(totalDuration),
        estimatedTotalWatchTimeHours: Math.round((totalDuration * totalViews) / 3600),
        bestByViews: formatVid(viewsSorted[0]),
        bestByLikes: formatVid(likesSorted[0]),
        bestByComments: formatVid(commentsSorted[0]),
        bestByEngagement: formatVid(engagementSorted[0]),
        worstByViews: formatVid(viewsSorted[viewsSorted.length - 1]),
        mostRecent: formatVid(dateSorted[0]),
        oldest: formatVid(dateSorted[dateSorted.length - 1]),
        top10ByViews: viewsSorted.slice(0, 10).map(formatVid),
        top10ByLikes: likesSorted.slice(0, 10).map(formatVid),
        top10ByComments: commentsSorted.slice(0, 10).map(formatVid),
        top10ByEngagement: engagementSorted.slice(0, 10).map(formatVid),
        shortsCount: shorts.length,
        regularCount: regular.length,
        avgShortViews: shorts.length > 0 ? Math.round(shorts.reduce((s, v) => s + v.viewCount, 0) / shorts.length) : 0,
        avgRegularViews: regular.length > 0 ? Math.round(regular.reduce((s, v) => s + v.viewCount, 0) / regular.length) : 0,
        avgShortLikes: shorts.length > 0 ? Math.round(shorts.reduce((s, v) => s + v.likeCount, 0) / shorts.length) : 0,
        avgRegularLikes: regular.length > 0 ? Math.round(regular.reduce((s, v) => s + v.likeCount, 0) / regular.length) : 0,
        hdCount, sdCount: videos.length - hdCount,
        hdPercentage: ((hdCount / videos.length) * 100).toFixed(1),
        captionCount, captionPercentage: ((captionCount / videos.length) * 100).toFixed(1),
        licensedCount, licensedPercentage: ((licensedCount / videos.length) * 100).toFixed(1),
        madeForKidsCount, embeddableCount,
        embeddablePercentage: ((embeddableCount / videos.length) * 100).toFixed(1),
        publishDayDistribution: dayDist,
        publishHourDistribution: hourDist,
        peakPublishDay: peakDay ? peakDay[0] : '',
        peakPublishHour: peakHour ? parseInt(peakHour[0]) : 0,
        durationDistribution: durationDist,
        categoryDistribution: catDist,
        tagFrequency,
        videosLast7Days: videosLast7,
        videosLast30Days: videosLast30,
        videosLast90Days: videosLast90,
        videosLast365Days: videosLast365,
        uploadFrequencyPerWeek: (videos.length / totalWeeks).toFixed(1),
        uploadFrequencyPerMonth: (videos.length / totalMonths).toFixed(1),
        consistencyScore,
        viralityScore,
        viewsDistribution: { ranges: viewsRanges, counts: viewsCounts },
        viewsTrend,
        engagementTrend,
        likeRateTrend,
    };
}

function formatCompact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
}

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// API Keys
app.get('/api/keys', async (req, res) => {
    const keys = await readJSON(API_KEYS_FILE);
    res.json({
        youtube: keys?.youtube || '',
        configured: !!keys?.youtube,
        instagram: {
            appId: keys?.instagram?.appId || '',
            appSecret: keys?.instagram?.appSecret || '',
            configured: !!(keys?.instagram?.appId && keys?.instagram?.appSecret),
        },
        cloudinary: {
            cloudName: keys?.cloudinary?.cloudName || '',
            uploadPreset: keys?.cloudinary?.uploadPreset || '',
            configured: !!(keys?.cloudinary?.cloudName && keys?.cloudinary?.uploadPreset),
        },
        github: {
            token: keys?.github?.token || '',
            repo: keys?.github?.repo || '',
            branch: keys?.github?.branch || 'main',
            configured: !!(keys?.github?.token && keys?.github?.repo),
        },
    });
});

app.post('/api/keys', async (req, res) => {
    const { youtube, instagram, cloudinary } = req.body;
    const keys = await readJSON(API_KEYS_FILE) || {};
    if (youtube !== undefined) keys.youtube = youtube;
    if (instagram !== undefined) {
        if (!keys.instagram) keys.instagram = {};
        if (instagram.appId !== undefined) keys.instagram.appId = instagram.appId;
        if (instagram.appSecret !== undefined) keys.instagram.appSecret = instagram.appSecret;
    }
    if (cloudinary !== undefined) {
        if (!keys.cloudinary) keys.cloudinary = {};
        if (cloudinary.cloudName !== undefined) keys.cloudinary.cloudName = cloudinary.cloudName;
        if (cloudinary.uploadPreset !== undefined) keys.cloudinary.uploadPreset = cloudinary.uploadPreset;
    }
    const { github } = req.body;
    if (github !== undefined) {
        if (!keys.github) keys.github = { branch: 'main' };
        if (github.token !== undefined) keys.github.token = github.token;
        if (github.repo !== undefined) keys.github.repo = github.repo;
        if (github.branch !== undefined) keys.github.branch = github.branch || 'main';
    }
    const ok = await writeJSON(API_KEYS_FILE, keys);
    res.json({ success: ok, message: ok ? 'API keys saved' : 'Failed to save' });
});

// Accounts
app.get('/api/accounts', async (req, res) => {
    const accounts = await readJSON(ACCOUNTS_FILE) || [];
    // Mask access tokens in response
    const safe = accounts.map(a => {
        const copy = { ...a };
        if (copy.accessToken) delete copy.accessToken;
        return copy;
    });
    res.json(safe);
});

// Resolve channel from URL or ID
app.post('/api/resolve-channel', async (req, res) => {
    try {
        const { input } = req.body;
        const apiKey = await getAPIKey();
        if (!apiKey) return res.status(400).json({ success: false, message: 'YouTube API key not configured' });

        const channelId = await resolveChannelId(input, apiKey);
        const channelData = await fetchChannelData(channelId, apiKey);
        res.json({ success: true, data: channelData });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Add account
app.post('/api/accounts', async (req, res) => {
    try {
        const { input } = req.body;
        const apiKey = await getAPIKey();
        if (!apiKey) return res.status(400).json({ success: false, message: 'YouTube API key not configured' });

        const channelId = await resolveChannelId(input, apiKey);
        const channelData = await fetchChannelData(channelId, apiKey);
        const accounts = await readJSON(ACCOUNTS_FILE);

        // Prevent duplicates
        if (accounts.find(a => a.channelId === channelId)) {
            return res.status(400).json({ success: false, message: 'This channel is already added' });
        }

        const newAccount = {
            id: Date.now().toString(),
            channelId: channelData.channelId,
            title: channelData.title,
            description: channelData.description,
            customUrl: channelData.customUrl,
            publishedAt: channelData.publishedAt,
            country: channelData.country,
            thumbnails: channelData.thumbnails,
            subscriberCount: channelData.subscriberCount,
            viewCount: channelData.viewCount,
            videoCount: channelData.videoCount,
            hiddenSubscriberCount: channelData.hiddenSubscriberCount,
            uploadsPlaylistId: channelData.uploadsPlaylistId,
            keywords: channelData.keywords,
            topicCategories: channelData.topicCategories,
            madeForKids: channelData.madeForKids,
            addedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
        };

        accounts.push(newAccount);
        await writeJSON(ACCOUNTS_FILE, accounts);
        syncEverythingToGitHub().catch(() => { });

        res.json({ success: true, account: newAccount });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Add Instagram account via access token
// Uses Instagram API with Instagram Login — token from App Dashboard or Business Login flow
app.post('/api/accounts/instagram', async (req, res) => {
    try {
        const { accessToken } = req.body;
        if (!accessToken) return res.status(400).json({ success: false, message: 'Access token is required' });

        const { appSecret } = await getIGAppCredentials();

        // Step 1: Try to exchange for long-lived token (if app secret is configured)
        // Tokens from App Dashboard are already long-lived (60 days)
        // Tokens from Business Login flow are short-lived (1 hour) and need exchange
        let finalToken = accessToken;
        let expiresIn = 0;
        if (appSecret) {
            try {
                const longToken = await exchangeForLongLivedToken(accessToken, appSecret);
                finalToken = longToken.accessToken;
                expiresIn = longToken.expiresIn;
                console.log('Token exchanged for long-lived token successfully');
            } catch (err) {
                // Token might already be long-lived (from App Dashboard) — use as-is
                console.log('Token exchange skipped (token may already be long-lived):', err.message);
            }
        } else {
            console.log('No Instagram App Secret configured — using token as-is (configure App Secret in Settings for long-lived tokens)');
        }

        // Step 2: Fetch profile using /me — no Facebook Pages discovery needed
        const profile = await fetchInstagramProfile(null, finalToken);

        if (!profile.igUserId) {
            throw new Error('Could not get Instagram User ID. Make sure the token has instagram_business_basic permission and is from a Business/Creator account.');
        }

        const accounts = await readJSON(ACCOUNTS_FILE);

        // Prevent duplicates
        if (accounts.find(a => a.platform === 'instagram' && a.igUserId === profile.igUserId)) {
            return res.status(400).json({ success: false, message: 'This Instagram account is already added' });
        }

        const newAccount = {
            id: Date.now().toString(),
            platform: 'instagram',
            igUserId: profile.igUserId,
            username: profile.username,
            title: profile.name || profile.username,
            biography: profile.biography,
            website: profile.website,
            profilePictureUrl: profile.profilePictureUrl,
            followersCount: profile.followersCount,
            followsCount: profile.followsCount,
            mediaCount: profile.mediaCount,
            accessToken: finalToken,
            tokenExpiresAt: expiresIn > 0
                ? new Date(Date.now() + expiresIn * 1000).toISOString()
                : null,
            addedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
        };

        accounts.push(newAccount);
        await writeJSON(ACCOUNTS_FILE, accounts);
        syncEverythingToGitHub().catch(() => { });

        // Mask token in response
        const safeAccount = { ...newAccount };
        delete safeAccount.accessToken;
        res.json({ success: true, account: safeAccount });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Refresh Instagram token (extend long-lived token for another 60 days)
// Uses: GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
app.post('/api/accounts/:id/refresh-ig-token', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE);
        const account = accounts.find(a => a.id === req.params.id && a.platform === 'instagram');
        if (!account) return res.status(404).json({ success: false, message: 'Instagram account not found' });
        if (!account.accessToken) return res.status(400).json({ success: false, message: 'No access token stored' });

        // Refresh long-lived token — must be at least 24 hours old and not expired
        const refreshed = await refreshLongLivedToken(account.accessToken);

        account.accessToken = refreshed.accessToken;
        account.tokenExpiresAt = new Date(Date.now() + (refreshed.expiresIn || 5184000) * 1000).toISOString();
        await writeJSON(ACCOUNTS_FILE, accounts);
        syncEverythingToGitHub().catch(() => { });
        res.json({ success: true, message: 'Token refreshed for another 60 days', expiresAt: account.tokenExpiresAt });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Delete account
app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE);
        const account = accounts.find(a => a.id === req.params.id);
        if (!account) return res.status(404).json({ success: false, message: 'Not found' });
        const filtered = accounts.filter(a => a.id !== req.params.id);
        await writeJSON(ACCOUNTS_FILE, filtered);
        syncEverythingToGitHub().catch(() => { });

        // Clean caches
        const cache = await readJSON(VIDEOS_CACHE_FILE);
        delete cache[req.params.id];
        await writeJSON(VIDEOS_CACHE_FILE, cache);

        const igCache = await readJSON(IG_CACHE_FILE) || {};
        delete igCache[req.params.id];
        await writeJSON(IG_CACHE_FILE, igCache);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Update single account
app.post('/api/accounts/:id/refresh', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE);
        const account = accounts.find(a => a.id === req.params.id);
        if (!account) return res.status(404).json({ success: false, message: 'Not found' });

        if (account.platform === 'instagram') {
            // Refresh Instagram account
            if (!account.accessToken) return res.status(400).json({ success: false, message: 'No access token' });
            const profile = await fetchInstagramProfile(account.igUserId, account.accessToken);
            account.followersCount = profile.followersCount;
            account.followsCount = profile.followsCount;
            account.mediaCount = profile.mediaCount;
            account.title = profile.name || profile.username;
            account.username = profile.username;
            account.profilePictureUrl = profile.profilePictureUrl;
            account.biography = profile.biography;
            account.website = profile.website;
            account.lastUpdated = new Date().toISOString();
        } else {
            // Refresh YouTube account
            const apiKey = await getAPIKey();
            if (!apiKey) return res.status(400).json({ success: false, message: 'No API key' });
            const channelData = await fetchChannelData(account.channelId, apiKey);
            account.subscriberCount = channelData.subscriberCount;
            account.viewCount = channelData.viewCount;
            account.videoCount = channelData.videoCount;
            account.title = channelData.title;
            account.description = channelData.description;
            account.thumbnails = channelData.thumbnails;
            account.customUrl = channelData.customUrl;
            account.country = channelData.country;
            account.keywords = channelData.keywords;
            account.topicCategories = channelData.topicCategories;
        }
        account.lastUpdated = new Date().toISOString();
        await writeJSON(ACCOUNTS_FILE, accounts);

        // Mask IG token in response
        const safeAccount = { ...account };
        if (safeAccount.accessToken) delete safeAccount.accessToken;
        res.json({ success: true, account: safeAccount });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Refresh all
app.post('/api/accounts/refresh-all', async (req, res) => {
    try {
        const apiKey = await getAPIKey();
        const accounts = await readJSON(ACCOUNTS_FILE);
        const results = [];

        for (const account of accounts) {
            try {
                if (account.platform === 'instagram') {
                    if (!account.accessToken) throw new Error('No access token');
                    const profile = await fetchInstagramProfile(account.igUserId, account.accessToken);
                    account.followersCount = profile.followersCount;
                    account.followsCount = profile.followsCount;
                    account.mediaCount = profile.mediaCount;
                    account.title = profile.name || profile.username;
                    account.username = profile.username;
                    account.profilePictureUrl = profile.profilePictureUrl;
                } else {
                    if (!apiKey) throw new Error('No YouTube API key');
                    const channelData = await fetchChannelData(account.channelId, apiKey);
                    account.subscriberCount = channelData.subscriberCount;
                    account.viewCount = channelData.viewCount;
                    account.videoCount = channelData.videoCount;
                    account.title = channelData.title;
                    account.thumbnails = channelData.thumbnails;
                }
                account.lastUpdated = new Date().toISOString();
                results.push({ id: account.id, success: true });
            } catch (err) {
                results.push({ id: account.id, success: false, error: err.message });
            }
        }

        await writeJSON(ACCOUNTS_FILE, accounts);
        // Mask IG tokens in response
        const safeAccounts = accounts.map(a => {
            const safe = { ...a };
            if (safe.accessToken) delete safe.accessToken;
            return safe;
        });
        res.json({ success: true, accounts: safeAccounts, results, updatedAt: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get full analytics for an account
app.get('/api/accounts/:id/analytics', async (req, res) => {
    try {
        const apiKey = await getAPIKey();
        if (!apiKey) return res.status(400).json({ success: false, message: 'No API key' });

        const accounts = await readJSON(ACCOUNTS_FILE);
        const account = accounts.find(a => a.id === req.params.id);
        if (!account) return res.status(404).json({ success: false, message: 'Not found' });

        // Fetch all videos (up to 500)
        const videos = await fetchAllVideos(account.uploadsPlaylistId, apiKey, 10);

        // Cache videos
        const cache = await readJSON(VIDEOS_CACHE_FILE) || {};
        cache[req.params.id] = { videos, fetchedAt: new Date().toISOString() };
        await writeJSON(VIDEOS_CACHE_FILE, cache);

        // Compute analytics
        const analytics = computeVideoAnalytics(videos);

        // If publishedAt is missing, fetch it
        if (!account.publishedAt) {
            try {
                const channelData = await fetchChannelData(account.channelId, apiKey);
                account.publishedAt = channelData.publishedAt;
                account.subscriberCount = channelData.subscriberCount;
                account.viewCount = channelData.viewCount;
                account.videoCount = channelData.videoCount;
                account.title = channelData.title;
                account.thumbnails = channelData.thumbnails;
                account.customUrl = channelData.customUrl;
                account.country = channelData.country;
                account.lastUpdated = new Date().toISOString();
                await writeJSON(ACCOUNTS_FILE, accounts);
            } catch (e) {
                console.error('Failed to backfill channel data:', e.message);
            }
        }

        // Channel-level computed metrics
        const channelAge = account.publishedAt
            ? Math.floor((Date.now() - new Date(account.publishedAt).getTime()) / 86400000)
            : 365;
        const viewsPerSub = account.subscriberCount > 0 ? (account.viewCount / account.subscriberCount).toFixed(1) : 0;
        const subsPerView = account.viewCount > 0 ? (account.subscriberCount / account.viewCount * 100).toFixed(4) : 0;
        const avgViewsPerVideo = account.videoCount > 0 ? Math.round(account.viewCount / account.videoCount) : 0;
        const avgSubGainPerDay = channelAge > 0 ? Math.round(account.subscriberCount / channelAge) : 0;
        const avgViewsPerDay = channelAge > 0 ? Math.round(account.viewCount / channelAge) : 0;

        res.json({
            success: true,
            channel: {
                ...account,
                channelAge,
                channelAgeYears: (channelAge / 365).toFixed(1),
                viewsPerSubscriber: parseFloat(viewsPerSub),
                subscriberToViewRatio: parseFloat(subsPerView),
                avgViewsPerVideo,
                avgSubGainPerDay,
                avgViewsPerDay,
                estimatedMonthlyViews: avgViewsPerDay * 30,
                estimatedMonthlySubGain: avgSubGainPerDay * 30,
                estimatedYearlyViews: avgViewsPerDay * 365,
                estimatedYearlySubGain: avgSubGainPerDay * 365,
            },
            analytics,
            videoCount: videos.length,
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Get cached videos
app.get('/api/accounts/:id/videos', async (req, res) => {
    try {
        const cache = await readJSON(VIDEOS_CACHE_FILE) || {};
        const accountCache = cache[req.params.id];

        if (accountCache && accountCache.videos) {
            return res.json({ success: true, videos: accountCache.videos, fetchedAt: accountCache.fetchedAt });
        }

        // Fetch fresh if no cache
        const apiKey = await getAPIKey();
        if (!apiKey) return res.status(400).json({ success: false, message: 'No API key' });

        const accounts = await readJSON(ACCOUNTS_FILE);
        const account = accounts.find(a => a.id === req.params.id);
        if (!account) return res.status(404).json({ success: false, message: 'Not found' });

        const videos = await fetchAllVideos(account.uploadsPlaylistId, apiKey, 10);
        cache[req.params.id] = { videos, fetchedAt: new Date().toISOString() };
        await writeJSON(VIDEOS_CACHE_FILE, cache);

        res.json({ success: true, videos, fetchedAt: cache[req.params.id].fetchedAt });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Cross-account comparison
app.get('/api/comparison', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE);
        if (accounts.length === 0) return res.json({ success: true, comparison: null });

        const sorted = {
            bySubscribers: [...accounts].sort((a, b) => b.subscriberCount - a.subscriberCount),
            byViews: [...accounts].sort((a, b) => b.viewCount - a.viewCount),
            byVideos: [...accounts].sort((a, b) => b.videoCount - a.videoCount),
        };

        const totals = accounts.reduce((acc, a) => ({
            subscribers: acc.subscribers + a.subscriberCount,
            views: acc.views + a.viewCount,
            videos: acc.videos + a.videoCount,
        }), { subscribers: 0, views: 0, videos: 0 });

        res.json({
            success: true,
            comparison: {
                rankings: sorted,
                totals,
                accountCount: accounts.length,
                bestBySubscribers: sorted.bySubscribers[0] || null,
                bestByViews: sorted.byViews[0] || null,
                bestByVideos: sorted.byVideos[0] || null,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Instagram analytics
app.get('/api/accounts/:id/ig-analytics', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE);
        const account = accounts.find(a => a.id === req.params.id && a.platform === 'instagram');
        if (!account) return res.status(404).json({ success: false, message: 'Instagram account not found' });
        if (!account.accessToken) return res.status(400).json({ success: false, message: 'No access token stored' });

        // Fetch fresh profile
        const profile = await fetchInstagramProfile(account.igUserId, account.accessToken);

        // Fetch media (up to 500 for thorough analytics)
        const media = await fetchInstagramMedia(account.igUserId, account.accessToken, 500);

        // Cache media
        const igCache = await readJSON(IG_CACHE_FILE) || {};
        igCache[req.params.id] = { media, fetchedAt: new Date().toISOString() };
        await writeJSON(IG_CACHE_FILE, igCache);

        // Compute analytics
        const analytics = computeInstagramAnalytics(profile, media);

        // Update account with latest stats
        account.followersCount = profile.followersCount;
        account.followsCount = profile.followsCount;
        account.mediaCount = profile.mediaCount;
        account.profilePictureUrl = profile.profilePictureUrl;
        account.lastUpdated = new Date().toISOString();
        await writeJSON(ACCOUNTS_FILE, accounts);

        const safeAccount = { ...account };
        delete safeAccount.accessToken;

        res.json({
            success: true,
            profile: { ...profile },
            account: safeAccount,
            analytics,
            mediaCount: media.length,
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Instagram media list
app.get('/api/accounts/:id/ig-media', async (req, res) => {
    try {
        // Check cache first
        const igCache = await readJSON(IG_CACHE_FILE) || {};
        const cached = igCache[req.params.id];
        if (cached && cached.media) {
            return res.json({ success: true, media: cached.media, fetchedAt: cached.fetchedAt });
        }

        const accounts = await readJSON(ACCOUNTS_FILE);
        const account = accounts.find(a => a.id === req.params.id && a.platform === 'instagram');
        if (!account) return res.status(404).json({ success: false, message: 'Not found' });
        if (!account.accessToken) return res.status(400).json({ success: false, message: 'No access token' });

        const media = await fetchInstagramMedia(account.igUserId, account.accessToken, 500);
        igCache[req.params.id] = { media, fetchedAt: new Date().toISOString() };
        await writeJSON(IG_CACHE_FILE, igCache);

        res.json({ success: true, media, fetchedAt: igCache[req.params.id].fetchedAt });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get ALL videos across all channels (or filter by channel)
app.get('/api/videos/all', async (req, res) => {
    try {
        const { channelId, sort, order, search, minViews, maxViews } = req.query;
        const cache = await readJSON(VIDEOS_CACHE_FILE) || {};
        const accounts = await readJSON(ACCOUNTS_FILE) || [];

        let allVideos = [];
        for (const acct of accounts) {
            if (channelId && acct.id !== channelId) continue;
            const cached = cache[acct.id];
            if (cached && cached.videos) {
                allVideos.push(...cached.videos.map(v => ({
                    ...v,
                    channelTitle: acct.title || acct.name || acct.channelTitle,
                    channelId: acct.id,
                    channelThumbnail: acct.thumbnails?.default || acct.thumbnailUrl || '',
                })));
            }
        }

        // Search filter
        if (search) {
            const q = search.toLowerCase();
            allVideos = allVideos.filter(v =>
                v.title?.toLowerCase().includes(q) ||
                (v.tags || []).some(t => t.toLowerCase().includes(q))
            );
        }

        // Views range filter
        if (minViews) allVideos = allVideos.filter(v => (v.viewCount || 0) >= parseInt(minViews));
        if (maxViews) allVideos = allVideos.filter(v => (v.viewCount || 0) <= parseInt(maxViews));

        // Sort
        const sortField = sort || 'viewCount';
        const sortOrder = order === 'asc' ? 1 : -1;
        allVideos.sort((a, b) => {
            const aVal = a[sortField] ?? 0;
            const bVal = b[sortField] ?? 0;
            if (typeof aVal === 'string') return sortOrder * aVal.localeCompare(bVal);
            return sortOrder * (bVal - aVal);
        });

        res.json({
            success: true,
            videos: allVideos,
            total: allVideos.length,
            channels: accounts.map(a => ({ id: a.id, title: a.title || a.name })),
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Start ───────────────────────────────────────────────────────────────────

// ─── Instagram Content Publishing ────────────────────────────────────────────

// Get Cloudinary config (for frontend)
app.get('/api/cloudinary-config', async (req, res) => {
    const keys = await readJSON(API_KEYS_FILE);
    const cloud = keys?.cloudinary || {};
    if (!cloud.cloudName || !cloud.uploadPreset) {
        return res.json({ success: false, message: 'Cloudinary not configured' });
    }
    res.json({ success: true, cloudName: cloud.cloudName, uploadPreset: cloud.uploadPreset });
});

// Check publishing rate limit
app.get('/api/accounts/:id/ig-publishing-limit', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE) || [];
        const acct = accounts.find(a => a.id === req.params.id);
        if (!acct || acct.platform !== 'instagram') {
            return res.status(404).json({ success: false, message: 'Instagram account not found' });
        }
        const r = await fetch(
            `https://graph.instagram.com/v25.0/${acct.igUserId}/content_publishing_limit?fields=quota_usage,config&access_token=${acct.accessToken}`
        );
        const data = await r.json();
        if (data.error) throw new Error(data.error.message);
        res.json({ success: true, ...data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Step 1: Create a media container on Instagram
app.post('/api/accounts/:id/ig-publish', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE) || [];
        const acct = accounts.find(a => a.id === req.params.id);
        if (!acct || acct.platform !== 'instagram') {
            return res.status(404).json({ success: false, message: 'Instagram account not found' });
        }

        const {
            mediaType,    // 'IMAGE', 'REELS', 'STORIES', 'CAROUSEL'
            mediaUrl,     // public URL of image or video (from Cloudinary)
            caption,
            coverUrl,     // cover image URL for reels
            shareToFeed,  // boolean for reels/stories
            collaborators,// array of usernames
            audioName,    // custom audio name for reels
            thumbOffset,  // thumbnail offset ms for reels
            locationId,   // location page ID
            userTags,     // array of {username, x, y}
            altText,      // image alt text
            children,     // array of container IDs for carousel
        } = req.body;

        const igId = acct.igUserId;
        const token = acct.accessToken;
        const params = { access_token: token };

        if (mediaType === 'CAROUSEL') {
            // Carousel container
            params.media_type = 'CAROUSEL';
            if (caption) params.caption = caption;
            if (children && children.length) params.children = children.join(',');
            if (collaborators && collaborators.length) params.collaborators = JSON.stringify(collaborators);
            if (locationId) params.location_id = locationId;
        } else if (mediaType === 'CAROUSEL_ITEM_IMAGE') {
            // Individual carousel item (image)
            params.image_url = mediaUrl;
            params.is_carousel_item = true;
        } else if (mediaType === 'CAROUSEL_ITEM_VIDEO') {
            // Individual carousel item (video)
            params.media_type = 'VIDEO';
            params.video_url = mediaUrl;
            params.is_carousel_item = true;
        } else if (mediaType === 'REELS') {
            params.media_type = 'REELS';
            params.video_url = mediaUrl;
            if (caption) params.caption = caption;
            if (shareToFeed !== undefined) params.share_to_feed = shareToFeed;
            if (coverUrl) params.cover_url = coverUrl;
            if (collaborators && collaborators.length) params.collaborators = JSON.stringify(collaborators);
            if (audioName) params.audio_name = audioName;
            if (thumbOffset != null) params.thumb_offset = thumbOffset;
            if (locationId) params.location_id = locationId;
            if (userTags && userTags.length) params.user_tags = JSON.stringify(userTags);
        } else if (mediaType === 'STORIES') {
            params.media_type = 'STORIES';
            // Determine if image or video stories
            if (mediaUrl && (mediaUrl.match(/\.(mp4|mov|avi|webm)/i))) {
                params.video_url = mediaUrl;
            } else {
                params.image_url = mediaUrl;
            }
            if (userTags && userTags.length) params.user_tags = JSON.stringify(userTags);
        } else {
            // Default: Image post
            params.image_url = mediaUrl;
            if (caption) params.caption = caption;
            if (locationId) params.location_id = locationId;
            if (userTags && userTags.length) params.user_tags = JSON.stringify(userTags);
            if (altText) params.alt_text = altText;
        }

        // Create container
        const qs = new URLSearchParams(params).toString();
        const r = await fetch(`https://graph.instagram.com/v25.0/${igId}/media?${qs}`, { method: 'POST' });
        const data = await r.json();

        if (data.error) throw new Error(data.error.message);

        res.json({ success: true, containerId: data.id });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Step 2: Check container status
app.get('/api/ig-container/:containerId/status', async (req, res) => {
    try {
        const { containerId } = req.params;
        const { accountId } = req.query;
        const accounts = await readJSON(ACCOUNTS_FILE) || [];
        const acct = accounts.find(a => a.id === accountId);
        if (!acct) return res.status(404).json({ success: false, message: 'Account not found' });

        const r = await fetch(
            `https://graph.instagram.com/v25.0/${containerId}?fields=status_code,status&access_token=${acct.accessToken}`
        );
        const data = await r.json();
        if (data.error) throw new Error(data.error.message);

        res.json({ success: true, statusCode: data.status_code, status: data.status });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Step 3: Publish the container
app.post('/api/accounts/:id/ig-media-publish', async (req, res) => {
    try {
        const accounts = await readJSON(ACCOUNTS_FILE) || [];
        const acct = accounts.find(a => a.id === req.params.id);
        if (!acct || acct.platform !== 'instagram') {
            return res.status(404).json({ success: false, message: 'Instagram account not found' });
        }

        const { containerId } = req.body;
        const r = await fetch(
            `https://graph.instagram.com/v25.0/${acct.igUserId}/media_publish?creation_id=${containerId}&access_token=${acct.accessToken}`,
            { method: 'POST' }
        );
        const data = await r.json();
        if (data.error) throw new Error(data.error.message);

        res.json({ success: true, mediaId: data.id });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Scheduled Posts ─────────────────────────────────────────────────────────

// Generate a simple unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Get all scheduled posts
app.get('/api/scheduled-posts', async (req, res) => {
    try {
        const posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        res.json({ success: true, posts });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Create a scheduled post (saves Cloudinary URL + metadata for local scheduler to process)
app.post('/api/scheduled-posts', async (req, res) => {
    try {
        const {
            accountId, platform, mediaType, mediaUrl,
            caption, coverUrl, shareToFeed, collaborators,
            audioName, thumbOffset, locationId, userTags,
            altText, scheduledAt,
        } = req.body;

        if (!accountId || !mediaUrl || !scheduledAt) {
            return res.status(400).json({ success: false, message: 'accountId, mediaUrl, and scheduledAt are required' });
        }

        const scheduledDate = new Date(scheduledAt);
        if (isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) {
            return res.status(400).json({ success: false, message: 'scheduledAt must be a valid future date' });
        }

        const post = {
            id: generateId(),
            accountId,
            platform: platform || 'instagram',
            mediaType: mediaType || 'IMAGE',
            mediaUrl,
            caption: caption || '',
            coverUrl: coverUrl || null,
            shareToFeed: shareToFeed !== undefined ? shareToFeed : true,
            collaborators: collaborators || [],
            audioName: audioName || '',
            thumbOffset: thumbOffset || null,
            locationId: locationId || '',
            userTags: userTags || [],
            altText: altText || '',
            scheduledAt: scheduledDate.toISOString(),
            status: 'pending',  // pending | publishing | published | failed
            createdAt: new Date().toISOString(),
            publishedMediaId: null,
            error: null,
        };

        const posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        posts.push(post);
        await writeJSON(SCHEDULED_POSTS_FILE, posts);

        // Sync to GitHub (async, don't block response)
        syncEverythingToGitHub().catch(() => { });

        res.json({ success: true, post });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Update a scheduled post
app.put('/api/scheduled-posts/:id', async (req, res) => {
    try {
        const posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        const idx = posts.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Scheduled post not found' });
        if (posts[idx].status !== 'pending' && posts[idx].status !== 'scheduled') {
            return res.status(400).json({ success: false, message: 'Can only edit pending posts' });
        }

        const allowed = ['caption', 'scheduledAt', 'shareToFeed', 'collaborators', 'audioName',
            'thumbOffset', 'locationId', 'userTags', 'altText', 'coverUrl'];
        for (const key of allowed) {
            if (req.body[key] !== undefined) posts[idx][key] = req.body[key];
        }
        if (req.body.scheduledAt) posts[idx].scheduledAt = new Date(req.body.scheduledAt).toISOString();

        await writeJSON(SCHEDULED_POSTS_FILE, posts);
        syncEverythingToGitHub().catch(() => { });
        res.json({ success: true, post: posts[idx] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Delete ALL scheduled posts (skips any currently publishing)
app.delete('/api/scheduled-posts', async (_req, res) => {
    try {
        let posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        const publishing = posts.filter(p => p.status === 'publishing');
        await writeJSON(SCHEDULED_POSTS_FILE, publishing); // keep only in-flight ones
        syncEverythingToGitHub().catch(() => { });
        res.json({ success: true, deleted: posts.length - publishing.length, kept: publishing.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Delete a scheduled post
app.delete('/api/scheduled-posts/:id', async (req, res) => {
    try {
        let posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        const post = posts.find(p => p.id === req.params.id);
        if (!post) return res.status(404).json({ success: false, message: 'Scheduled post not found' });
        if (post.status === 'publishing') {
            return res.status(400).json({ success: false, message: 'Cannot delete a post that is currently publishing' });
        }
        posts = posts.filter(p => p.id !== req.params.id);
        await writeJSON(SCHEDULED_POSTS_FILE, posts);
        syncEverythingToGitHub().catch(() => { });
        res.json({ success: true, message: 'Scheduled post deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Scheduled Post Processor ────────────────────────────────────────────────
// Runs locally via setInterval. Checks every 60 seconds for due posts.
// On server startup, immediately processes any overdue posts.

let isProcessing = false;

async function processScheduledPosts() {
    if (isProcessing) return { processed: 0, message: 'Already processing' };
    isProcessing = true;
    let processed = 0;
    let errors = [];

    try {
        const posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        const accounts = await readJSON(ACCOUNTS_FILE) || [];
        const now = new Date();

        for (const post of posts) {
            if (post.status !== 'pending') continue;
            const scheduledDate = new Date(post.scheduledAt);
            if (scheduledDate > now) continue;

            // This post is due — publish it
            post.status = 'publishing';
            await writeJSON(SCHEDULED_POSTS_FILE, posts);

            try {
                const acct = accounts.find(a => a.id === post.accountId);
                if (!acct) throw new Error('Account not found: ' + post.accountId);

                // Step 1: Create container
                const igId = acct.igUserId;
                const token = acct.accessToken;
                const params = { access_token: token };

                if (post.mediaType === 'REELS') {
                    params.media_type = 'REELS';
                    params.video_url = post.mediaUrl;
                    if (post.caption) params.caption = post.caption;
                    if (post.shareToFeed !== undefined) params.share_to_feed = post.shareToFeed;
                    if (post.coverUrl) params.cover_url = post.coverUrl;
                    if (post.collaborators?.length) params.collaborators = JSON.stringify(post.collaborators);
                    if (post.audioName) params.audio_name = post.audioName;
                    if (post.thumbOffset != null) params.thumb_offset = post.thumbOffset;
                    if (post.locationId) params.location_id = post.locationId;
                    if (post.userTags?.length) params.user_tags = JSON.stringify(post.userTags);
                } else if (post.mediaType === 'STORIES') {
                    params.media_type = 'STORIES';
                    if (post.mediaUrl.match(/\.(mp4|mov|avi|webm)/i)) {
                        params.video_url = post.mediaUrl;
                    } else {
                        params.image_url = post.mediaUrl;
                    }
                    if (post.userTags?.length) params.user_tags = JSON.stringify(post.userTags);
                } else {
                    // IMAGE
                    params.image_url = post.mediaUrl;
                    if (post.caption) params.caption = post.caption;
                    if (post.locationId) params.location_id = post.locationId;
                    if (post.userTags?.length) params.user_tags = JSON.stringify(post.userTags);
                    if (post.altText) params.alt_text = post.altText;
                }

                const qs = new URLSearchParams(params).toString();
                const createRes = await fetch(`https://graph.instagram.com/v25.0/${igId}/media?${qs}`, { method: 'POST' });
                const createData = await createRes.json();
                if (createData.error) throw new Error(createData.error.message);

                const containerId = createData.id;

                // Step 2: Wait for processing (poll up to 60 attempts, 3s apart = 3 min max)
                if (post.mediaType === 'REELS' || post.mediaType === 'STORIES') {
                    for (let i = 0; i < 60; i++) {
                        await new Promise(r => setTimeout(r, 3000));
                        const statusRes = await fetch(
                            `https://graph.instagram.com/v25.0/${containerId}?fields=status_code,status&access_token=${token}`
                        );
                        const statusData = await statusRes.json();
                        if (statusData.status_code === 'FINISHED' || statusData.status_code === 'PUBLISHED') break;
                        if (statusData.status_code === 'ERROR') throw new Error('Processing failed: ' + (statusData.status || ''));
                        if (statusData.status_code === 'EXPIRED') throw new Error('Container expired');
                    }
                } else {
                    await new Promise(r => setTimeout(r, 2000));
                }

                // Step 3: Publish
                const pubRes = await fetch(
                    `https://graph.instagram.com/v25.0/${igId}/media_publish?creation_id=${containerId}&access_token=${token}`,
                    { method: 'POST' }
                );
                const pubData = await pubRes.json();
                if (pubData.error) throw new Error(pubData.error.message);

                post.status = 'published';
                post.publishedMediaId = pubData.id;
                post.publishedAt = new Date().toISOString();
                processed++;
                console.log(`  ✓ Published scheduled post ${post.id} → media ${pubData.id}`);

            } catch (err) {
                post.status = 'failed';
                post.error = err.message;
                errors.push({ id: post.id, error: err.message });
                console.error(`  ✗ Failed to publish scheduled post ${post.id}: ${err.message}`);
            }

            await writeJSON(SCHEDULED_POSTS_FILE, posts);
        }
    } catch (err) {
        console.error('Scheduler error:', err);
    } finally {
        isProcessing = false;
    }

    return { processed, errors };
}

// Manual trigger endpoint
app.get('/api/process-scheduled', async (req, res) => {
    const result = await processScheduledPosts();
    res.json({ success: true, ...result, timestamp: new Date().toISOString() });
});
app.post('/api/process-scheduled', async (req, res) => {
    const result = await processScheduledPosts();
    res.json({ success: true, ...result, timestamp: new Date().toISOString() });
});

// GitHub sync test endpoint
app.post('/api/github-sync', async (req, res) => {
    try {
        await syncEverythingToGitHub();
        res.json({ success: true, message: 'Synced all data files to GitHub' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/github-pull', async (req, res) => {
    try {
        await pullScheduledPostsFromGitHub();
        const posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        res.json({ success: true, posts, message: 'Pulled from GitHub' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

initializeData().then(async () => {
    // Pull latest from GitHub on startup (picks up posts published by GH Actions while server was off)
    await pullScheduledPostsFromGitHub();

    // Process any overdue posts on startup
    const posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
    const overdue = posts.filter(p => p.status === 'pending' && new Date(p.scheduledAt) <= new Date());
    if (overdue.length > 0) {
        console.log(`  ⏰ ${overdue.length} overdue scheduled post(s) found, publishing now...`);
        await processScheduledPosts();
    }

    // Check every 60 seconds for due posts
    setInterval(async () => {
        const posts = await readJSON(SCHEDULED_POSTS_FILE) || [];
        const due = posts.filter(p => p.status === 'pending' && new Date(p.scheduledAt) <= new Date());
        if (due.length > 0) {
            console.log(`\n  ⏰ ${due.length} scheduled post(s) due, processing...`);
            await processScheduledPosts();
        }
    }, 60000);

    // Check Instagram token expiry once on startup, then every 24 hours
    autoRefreshInstagramTokens();
    setInterval(autoRefreshInstagramTokens, 24 * 60 * 60 * 1000);

    app.listen(PORT, () => {
        console.log(`\n  Social Media Analytics API Server`);
        console.log(`  Running on http://localhost:${PORT}`);
        console.log(`  YouTube + Instagram analytics ready`);
        console.log(`  📅 Scheduler active (checks every 60s)`);
        console.log(`  🔑 Instagram token auto-refresh active (checks every 24h)\n`);
    });
});
