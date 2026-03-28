const API = 'http://localhost:3001/api';

async function request(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const data = await res.json();
    if (!res.ok && !data.success) throw new Error(data.message || 'Request failed');
    return data;
}

export const api = {
    // Health
    health: () => request('/health'),

    // API Keys
    getKeys: () => request('/keys'),
    saveKey: (youtube) => request('/keys', { method: 'POST', body: JSON.stringify({ youtube }) }),
    saveKeys: (data) => request('/keys', { method: 'POST', body: JSON.stringify(data) }),

    // Accounts
    getAccounts: () => request('/accounts'),
    addAccount: (input) => request('/accounts', { method: 'POST', body: JSON.stringify({ input }) }),
    deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),
    refreshAccount: (id) => request(`/accounts/${id}/refresh`, { method: 'POST' }),
    refreshAll: () => request('/accounts/refresh-all', { method: 'POST' }),

    // Instagram accounts
    addInstagramAccount: (accessToken) => request('/accounts/instagram', { method: 'POST', body: JSON.stringify({ accessToken }) }),
    refreshIGToken: (id) => request(`/accounts/${id}/refresh-ig-token`, { method: 'POST' }),
    getIGAnalytics: (id) => request(`/accounts/${id}/ig-analytics`),
    getIGMedia: (id) => request(`/accounts/${id}/ig-media`),

    // Channel URL/ID resolution
    resolveChannel: (input) => request('/resolve-channel', { method: 'POST', body: JSON.stringify({ input }) }),

    // Analytics (YouTube)
    getAnalytics: (id) => request(`/accounts/${id}/analytics`),
    getVideos: (id) => request(`/accounts/${id}/videos`),

    // Comparison
    getComparison: () => request('/comparison'),

    // Cloudinary config
    getCloudinaryConfig: () => request('/cloudinary-config'),

    // Instagram Publishing
    getIGPublishingLimit: (id) => request(`/accounts/${id}/ig-publishing-limit`),
    createIGContainer: (id, data) => request(`/accounts/${id}/ig-publish`, { method: 'POST', body: JSON.stringify(data) }),
    getIGContainerStatus: (containerId, accountId) => request(`/ig-container/${containerId}/status?accountId=${accountId}`),
    publishIGContainer: (id, containerId) => request(`/accounts/${id}/ig-media-publish`, { method: 'POST', body: JSON.stringify({ containerId }) }),

    // Scheduled Posts
    getScheduledPosts: () => request('/scheduled-posts'),
    createScheduledPost: (data) => request('/scheduled-posts', { method: 'POST', body: JSON.stringify(data) }),
    updateScheduledPost: (id, data) => request(`/scheduled-posts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScheduledPost: (id) => request(`/scheduled-posts/${id}`, { method: 'DELETE' }),
    deleteAllScheduledPosts: () => request('/scheduled-posts', { method: 'DELETE' }),
    processScheduled: () => request('/process-scheduled'),

    // GitHub Sync
    syncToGitHub: () => request('/github-sync', { method: 'POST' }),
    pullFromGitHub: () => request('/github-pull', { method: 'POST' }),
};
