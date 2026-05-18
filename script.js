// CSRF-aware POST helper. Reads window.CSRF_TOKEN injected by index.php.
window.apiPost = function (endpoint, payload) {
    return fetch(`backend.php?endpoint=${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.CSRF_TOKEN || ''
        },
        body: JSON.stringify(payload)
    });
};

// Sound packs (Phase 3.7). `classic` is the existing AIM/AOL set; `quiet`
// suppresses everything except chat for a low-distraction mode. `aol3` is
// a placeholder for future asset work — currently aliases to classic so the
// picker shows it but selecting it doesn't break anything. Each pack
// declares either `allowAll: true` or an `allowed: Set<string>` of audio
// element ids it permits through.
window.AIM_SOUND_PACKS = {
    classic: {
        label: 'Classic AIM',
        allowAll: true,
    },
    quiet: {
        label: 'Quiet (chat only)',
        allowed: new Set(['chat-sound']),
    },
    aol3: {
        label: 'AOL 3.0 (coming soon)',
        allowAll: true, // same set as classic until period-correct WAVs are sourced
    },
};

// Sound effects. opts.force=true plays even when the user disabled sounds
// (used for the "you've got mail" login chime and the "goodbye" send-off,
// where the sound is part of the UX, not a notification).
window.playSound = function (id, opts) {
    opts = opts || {};
    try {
        // getUserProfile is defined later; guard for the splash screen, which
        // runs before the desktop is initialized and before profile exists.
        if (!opts.force && typeof getUserProfile === 'function') {
            const profile = getUserProfile();
            if (profile && profile.soundEnabled === false) return Promise.resolve();
            // Sound-pack filter: if the active pack doesn't permit this id,
            // skip silently. Profile.soundPack defaults to 'classic' for
            // backward compat with pre-Phase-3 users.
            const packId = (profile && profile.soundPack) || 'classic';
            const pack = window.AIM_SOUND_PACKS[packId] || window.AIM_SOUND_PACKS.classic;
            if (!pack.allowAll && !pack.allowed.has(id)) return Promise.resolve();
        }
    } catch (_) { /* fall through */ }
    const el = document.getElementById(id);
    if (!el) return Promise.resolve();
    try { el.currentTime = 0; } catch (_) {}
    const p = el.play();
    return p && typeof p.catch === 'function' ? p.catch(() => {}) : Promise.resolve();
};

document.addEventListener('DOMContentLoaded', () => {
    // Set up resize end handler for resizable windows (desktop only)
    if (window.innerWidth >= 1025) {
        // Listen for resize end to adjust content
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // Update scroll position for chat windows after resize
                document.querySelectorAll('.chat-messages').forEach(container => {
                    container.scrollTop = container.scrollHeight;
                });
            }, 100);
        });
    }
    
    // Login flow:
    //   1. Sign-on form shows immediately (no splash on page load).
    //   2. User submits → we play the dial-up splash (signon1→2→3 + modem)
    //      as a transition, then reload into the logged-in desktop.
    //   3. Desktop initializeDesktop() plays the welcome chime (startup.wav).
    //
    // playSignOnSplash(onComplete) runs the splash sequence in place and
    // calls onComplete when the modem fade finishes. Defined on window so the
    // login + register button handlers below can both call it.
    const splashScreen = document.getElementById('splash-screen');
    if (splashScreen) {
        window.playSignOnSplash = function (onComplete) {
            const splash = document.getElementById('splash-screen');
            const splashImage = document.getElementById('splash-image');
            const splashCaption = document.getElementById('splash-caption');
            const loginWindow = document.getElementById('login-window');
            if (!splash) { if (onComplete) onComplete(); return; }

            // Hide the login form so the splash takes over the screen.
            if (loginWindow) loginWindow.style.display = 'none';
            splash.classList.remove('fade-out');
            splash.style.display = 'flex';

            // Dial-up modem soundtrack — force=true: this is the UX, not a
            // notification, so respect the moment even if sounds are off.
            playSound('connecting-sound', { force: true });

            const FRAME_MS = 750;
            const frames = [
                { src: 'images/signon1.png', caption: 'Dialing&hellip;' },
                { src: 'images/signon2.png', caption: 'Connecting&hellip;' },
                { src: 'images/signon3.png', caption: 'Welcome to AIM Chat' }
            ];
            const stepTo = (i) => {
                const f = frames[i];
                if (splashImage) {
                    splashImage.src = f.src;
                    splashImage.alt = f.caption.replace(/&hellip;/g, '…');
                }
                if (splashCaption) splashCaption.innerHTML = f.caption;
            };

            stepTo(0);
            setTimeout(() => stepTo(1), FRAME_MS);
            setTimeout(() => stepTo(2), FRAME_MS * 2);

            setTimeout(() => {
                splash.classList.add('fade-out');
                const connecting = document.getElementById('connecting-sound');
                if (connecting) {
                    const t0 = connecting.volume;
                    const start = performance.now();
                    const FADE_MS = 350;
                    const tick = (now) => {
                        const k = Math.min(1, (now - start) / FADE_MS);
                        try { connecting.volume = t0 * (1 - k); } catch (_) {}
                        if (k < 1) requestAnimationFrame(tick);
                        else { try { connecting.pause(); connecting.currentTime = 0; connecting.volume = t0; } catch (_) {} }
                    };
                    requestAnimationFrame(tick);
                }
                setTimeout(() => { if (onComplete) onComplete(); }, 350);
            }, FRAME_MS * 3);
        };
        
        // Set up login form handlers
        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');
        const showRegisterButton = document.getElementById('show-register');
        const showLoginButton = document.getElementById('show-login');
        const loginButton = document.getElementById('login-button');
        const registerButton = document.getElementById('register-button');
        
        // Add keyboard support for better accessibility and user experience
        document.getElementById('username').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('password').focus();
            }
        });
        
        document.getElementById('password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                loginButton.click();
            }
        });
        
        document.getElementById('new-username').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('new-password').focus();
            }
        });
        
        document.getElementById('new-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('confirm-password').focus();
            }
        });
        
        document.getElementById('confirm-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                registerButton.click();
            }
        });
        
        // Switch between login and register forms with better mobile handling
        showRegisterButton.addEventListener('click', () => {
            loginForm.classList.remove('active');
            // Small delay for better animation feel
            setTimeout(() => {
                registerForm.classList.add('active');
                // Auto-focus first field in register form - better mobile UX
                document.getElementById('new-username').focus();
            }, 100);
        });
        
        showLoginButton.addEventListener('click', () => {
            registerForm.classList.remove('active');
            // Small delay for better animation feel
            setTimeout(() => {
                loginForm.classList.add('active');
                // Auto-focus first field in login form - better mobile UX
                document.getElementById('username').focus();
            }, 100);
        });
        
        // Handle login with improved UX
        loginButton.addEventListener('click', () => {
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            const loginError = document.getElementById('login-error');
            
            // Reset error message
            loginError.textContent = '';
            
            if (!username || !password) {
                loginError.textContent = 'Please enter both username and password';
                playSound('error-sound');
                return;
            }
            
            // Show loading state
            loginButton.disabled = true;
            loginButton.textContent = 'Signing In...';
            
            window.apiPost('login', { username, password })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // Play the AIM dial-up splash (signon1→2→3 + modem)
                    // as the transition, then reload into the desktop.
                    if (typeof window.playSignOnSplash === 'function') {
                        window.playSignOnSplash(() => { window.location.reload(); });
                    } else {
                        window.location.reload();
                    }
                } else {
                    loginError.textContent = data.error || 'Invalid username or password';
                    playSound('error-sound');
                    loginButton.disabled = false;
                    loginButton.textContent = 'Sign In';
                }
            })
            .catch(error => {
                console.error('Login error:', error);
                loginError.textContent = 'An error occurred. Please try again.';
                playSound('error-sound');
                loginButton.disabled = false;
                loginButton.textContent = 'Sign In';
            });
        });
        
        // Handle registration with improved validation
        registerButton.addEventListener('click', () => {
            const username = document.getElementById('new-username').value.trim();
            const password = document.getElementById('new-password').value;
            const confirmPassword = document.getElementById('confirm-password').value;
            const registerError = document.getElementById('register-error');
            
            // Reset error message
            registerError.textContent = '';
            
            // Validate all fields
            if (!username || !password || !confirmPassword) {
                registerError.textContent = 'Please fill in all fields';
                playSound('error-sound');
                return;
            }
            
            // Username validation
            if (username.length < 3) {
                registerError.textContent = 'Username must be at least 3 characters';
                playSound('error-sound');
                return;
            }
            
            // Password validation
            if (password.length < 6) {
                registerError.textContent = 'Password must be at least 6 characters';
                playSound('error-sound');
                return;
            }
            
            // Password matching
            if (password !== confirmPassword) {
                registerError.textContent = 'Passwords do not match';
                playSound('error-sound');
                return;
            }
            
            // Show loading state
            registerButton.disabled = true;
            registerButton.textContent = 'Creating Account...';
            
            window.apiPost('register', { username, password })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    if (typeof window.playSignOnSplash === 'function') {
                        window.playSignOnSplash(() => { window.location.reload(); });
                    } else {
                        window.location.reload();
                    }
                } else {
                    registerError.textContent = data.error || 'Failed to create account';
                    playSound('error-sound');
                    registerButton.disabled = false;
                    registerButton.textContent = 'Create Account';
                }
            })
            .catch(error => {
                console.error('Registration error:', error);
                registerError.textContent = 'An error occurred. Please try again.';
                playSound('error-sound');
                registerButton.disabled = false;
                registerButton.textContent = 'Create Account';
            });
        });
    }
    
    // Set up clock in taskbar
    updateTaskbarClock();
    setInterval(updateTaskbarClock, 60000);
    
    // Initialize windows if user is logged in
    if (typeof userInfo !== 'undefined') {
        initializeDesktop();
    }
    
    // Start Menu functionality
    const startButton = document.querySelector('.start-button');
    if (startButton) {
        createStartMenu();
        startButton.addEventListener('click', toggleStartMenu);
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.start-menu') && !e.target.closest('.start-button')) {
                hideStartMenu();
            }
        });
    }
    
    // Handle window controls
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('close')) {
            const window = e.target.closest('.window');
            if (window) {
                window.style.display = 'none';
                // AIM '95 closing-window chime.
                playSound('drop-sound');
                const taskbarItem = document.querySelector(`.taskbar-item[data-window="${window.id}"]`);
                if (taskbarItem) {
                    taskbarItem.remove();
                }

                // If it's a chat window, update active rooms count
                if (window.classList.contains('chat-window') && window.id !== 'chat-window-template') {
                    updateActiveRoomsCount();
                }
            }
        } else if (e.target.classList.contains('minimize')) {
            const window = e.target.closest('.window');
            if (window) {
                window.style.display = 'none';
                const taskbarItem = document.querySelector(`.taskbar-item[data-window="${window.id}"]`);
                if (taskbarItem) {
                    taskbarItem.classList.remove('active');
                }
            }
        } else if (e.target.classList.contains('maximize')) {
            const window = e.target.closest('.window');
            if (window) {
                if (window.classList.contains('maximized')) {
                    // Restore window to previous size
                    window.style.width = window.dataset.prevWidth || window.dataset.originalWidth;
                    window.style.height = window.dataset.prevHeight || window.dataset.originalHeight;
                    window.style.top = window.dataset.prevTop || '100px';
                    window.style.left = window.dataset.prevLeft || '100px';
                    window.classList.remove('maximized');
                    
                    // Scroll chat messages to bottom if this is a chat window
                    const messagesContainer = window.querySelector('.chat-messages');
                    if (messagesContainer) {
                        setTimeout(() => {
                            messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        }, 10);
                    }
                } else {
                    // Store current size and position
                    window.dataset.prevWidth = window.style.width;
                    window.dataset.prevHeight = window.style.height;
                    window.dataset.prevTop = window.style.top;
                    window.dataset.prevLeft = window.style.left;
                    
                    // Maximize window
                    window.style.width = '100%';
                    window.style.height = 'calc(100% - 28px)';
                    window.style.top = '0';
                    window.style.left = '0';
                    window.classList.add('maximized');
                    
                    // Scroll chat messages to bottom if this is a chat window
                    const messagesContainer = window.querySelector('.chat-messages');
                    if (messagesContainer) {
                        setTimeout(() => {
                            messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        }, 10);
                    }
                }
            }
        }
    });
});

// Start Menu Functions
function createStartMenu() {
    const startMenu = document.createElement('div');
    startMenu.className = 'start-menu';
    startMenu.id = 'start-menu';
    startMenu.style.display = 'none';
    
    // Create the Windows 95 start menu structure
    let menuContent = `
        <div class="start-menu-header">
            <div class="start-menu-title">Windows 95</div>
        </div>
        <div class="start-menu-items">
            <div class="start-menu-item" id="start-menu-chats">
                <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwQAADsEBuJFr7QAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xOdTWsmQAAADnSURBVDhPlZK9DcJAEIRdAiVQAiVQAh1QAiWkBEqgBFdACZRACZRgvrF2pdOLMRrp9m5n/052R5KzkdwkvcnD5GEsZ11iPHvJs8tzy3JoqI8tnDSVN1PQGeQHK50fZmb1bWb9F30R+COvZrMaKyb1ixmbShV3qxE6M5mTDkz8Q9YwVDWPwVge5Yl4uUeIhqFPxo5ZF5fhGQZzMp/o/GGOqTpYj1YjXJOVDK1Vcg411QhG5osdnMBETA+zmZOaHJA+QFd1gpyNoBK/RKmZ2etTZGQq/tyXKP6NmCFrMx1mUcqO5AFOJfoAYCh6ARA7zsYAAAAASUVORK5CYII=">
                <span>Chats</span>
            </div>
            <div class="start-menu-item" id="start-menu-profile">
                <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwQAADsEBuJFr7QAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xOdTWsmQAAAFVSURBVDhPjZLLSsNAFIYzMzfJTJK2SboRF4J4Bd2JggvBha/hwrW+gDufQlyJCxHBlS5c+AyC4EZciLgQLPYiaWqSvpvkOEeTtDYVB/4M55z/+88wQ8h/3dTr2jpN097tdqemabtjUJblMl5VMrlfafPAGdiartdniqLM4MX7qqrmiDFWRk9wnmez13Z7qlBKPTpCkHQ6PeF5PonjOIzjeIRgVAOSNWgOw7ABYCR9gHUu0XVYG2MMwD8B+qAGJGvQHARB487zxlySFKSOA/OgBiRrfzez2VsikUhxWUaZJD0VCNiCGpCs/dWZ6R45TRTFgmUYRwUC1+r1PSZJEld/a7ebMGUt0pRxsA9qQLLGRXEc+1ySNoHnbUSiKMoaVVVbEBABP6q1WpXBp6YoikOFUhoYhrGCdwABjut5E3g+Z9s27XQ6U/BSybZte3aR5/N5Bf7Ef5FovyJRCPkF9Xg5I5s04FsAAAAASUVORK5CYII=">
                <span>My Profile</span>
            </div>
            <div class="start-menu-item" id="start-menu-active-now">
                <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwQAADsEBuJFr7QAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xOdTWsmQAAAFSSURBVDhPnZLNSsNAFIVnZm6SmSRtkm5EEcSFWkEQXLjwNdQn8DkU3VfBnSCIC8GNCxeuXRVBKKKIiFZtkyat+TNJxnOaNG1pxYFvce+ZM9+9ZAbYp/v9/iHCQ7/fX6EopUc0TRMQF4qinI1Go+vpdLqE1TTNE0mSIsQKJpOJul3gARcIz6IoamzbXsQh7vZ6vQWu2+22MHl1OBxeMorL5SIxDENH2IhEUbzFhf54PD7BOh6PHWSakiRth8Ph6XQ65XieDwghQbvdPkbo8H1/icEiM9Mqw7JsBFO34Ac3ENSz2eyD4zgO7yHBcDi8xv8TQRCCoSgsA7fbXSgMY5qmj9ioIQhCHoYhyLJ8kWXZR5ZlkKYp/nzgOM4Vz/NZnucQx3FZoEJV1Y5lWRs07BqGUWPaLtA0TcTXF8jyfd/HfpFXZpXL5R5FUbxRVXUrB3+H/U5rgB8J0JfwJCDJaQAAAABJRU5ErkJggg==">
                <span>Buddy List</span>
            </div>
            <div class="start-menu-divider"></div>
            <div class="start-menu-item" id="start-menu-logout">
                <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwgAADsIBFShKgAAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xOdTWsmQAAAFYSURBVDhPnZI9S8NQFIbv5N6bm5uk+dDaIlhFEKQgDg5O/gBxEnRycvM/OLg7uOjk5OAgTg4ODg4dHBwEEbSI2mptbJM0aZrGnFtuQhRbKb7wDOfec97ncHIJtWmxOOe6bT8ajvPW9cV0aZZnGUeUdV1vWJZ1WSqVrlEbPc8TuWBPUZQnmA8qpqIoV4SQ9SRJChj9IEmS3MACgaHpuu4JTZXjOCFFURg0TQtJkhRhfCpKUhtztlKpHBOD4yQxcATJHJE5Xq95nrxUq9ULHSFhZhhGmOc5iBktXdctl7aAk+f5Pfb8Bdx+LvzPVgcGJ45jPyyK9yiK2JiAMxCCvizLLZig7XleFcZEEIQWvv1blmVrQRBAGIYjgRmgKIqMsUscY4fwK1mW9RAEQYsDw1AHxH2lw2g2m0foA0MqQgjv9XrUtu1TxJ9zfgG9QJzP+QL6HUFfRtM5LwAAAABJRU5ErkJggg==">
                <span>Log Out</span>
            </div>
        </div>
    `;
    
    startMenu.innerHTML = menuContent;
    document.querySelector('.win95-container').appendChild(startMenu);
    
    // Inject the Phase 4 additions (Toys + Spectate + Leaderboard) into the
    // Start menu. Added programmatically so the existing item HTML stays
    // unchanged and the new items inherit the same icon-less list style.
    const items = startMenu.querySelector('.start-menu-items');
    if (items) {
        const divider = items.querySelector('.start-menu-divider');
        const inject = (id, label, emoji) => {
            const el = document.createElement('div');
            el.className = 'start-menu-item';
            el.id = id;
            el.innerHTML = `<span class="start-menu-emoji">${emoji}</span><span>${label}</span>`;
            items.insertBefore(el, divider);
            return el;
        };
        inject('start-menu-spectate',     'Spectate Games', '👀');
        inject('start-menu-leaderboard',  'Top Players',    '🏆');
        inject('start-menu-mailbox',      'Mailbox',        '📬');
        inject('start-menu-toys-8ball',   'Magic 8-Ball',   '🎱');
        inject('start-menu-toys-snake',   'Snake',          '🐍');
    }

    // Add event listeners to menu items
    document.getElementById('start-menu-chats').addEventListener('click', () => {
        hideStartMenu();
        showWindow('chatrooms-window');
        loadChatrooms();
    });

    document.getElementById('start-menu-profile').addEventListener('click', () => {
        hideStartMenu();
        showProfileWindow();
    });

    document.getElementById('start-menu-active-now').addEventListener('click', () => {
        hideStartMenu();
        showActiveNowWindow();
    });

    document.getElementById('start-menu-logout').addEventListener('click', () => {
        signOff();
    });

    // Phase 4 menu items
    document.getElementById('start-menu-spectate').addEventListener('click', () => {
        hideStartMenu();
        showSpectateWindow();
    });
    document.getElementById('start-menu-leaderboard').addEventListener('click', () => {
        hideStartMenu();
        showLeaderboardWindow();
    });
    document.getElementById('start-menu-mailbox').addEventListener('click', () => {
        hideStartMenu();
        showMailWindow();
    });
    document.getElementById('start-menu-toys-8ball').addEventListener('click', () => {
        hideStartMenu();
        showMagic8BallWindow();
    });
    document.getElementById('start-menu-toys-snake').addEventListener('click', () => {
        hideStartMenu();
        showSnakeWindow();
    });
}

function toggleStartMenu() {
    const startMenu = document.getElementById('start-menu');
    if (startMenu.style.display === 'none') {
        startMenu.style.display = 'block';
        document.querySelector('.start-button').classList.add('active');
    } else {
        hideStartMenu();
    }
}

function hideStartMenu() {
    const startMenu = document.getElementById('start-menu');
    if (startMenu) {
        startMenu.style.display = 'none';
        document.querySelector('.start-button').classList.remove('active');
    }
}

function showProfileWindow() {
    let profileWindow = document.getElementById('profile-window');
    
    if (!profileWindow) {
        // Create user profile window
        profileWindow = document.createElement('div');
        profileWindow.id = 'profile-window';
        profileWindow.className = 'window';
        profileWindow.style.width = '440px';
        profileWindow.style.height = '580px';
        profileWindow.style.top = '60px';
        profileWindow.style.left = '150px';
        
        // Load user profile data from localStorage or use defaults
        const userProfile = getUserProfile();
        
        profileWindow.innerHTML = `
            <div class="window-header">
                <div class="window-title">My Profile - ${userInfo.nickname}</div>
                <div class="window-controls">
                    <button class="control-button minimize">-</button>
                    <button class="control-button maximize">□</button>
                    <button class="control-button close">×</button>
                </div>
            </div>
            <div class="window-content">
                <div class="profile-container">
                    <div class="profile-header">
                        <div class="profile-avatar" style="background-color: ${userProfile.avatarColor};">
                            ${userInfo.nickname.charAt(0).toUpperCase()}
                        </div>
                        <div class="profile-info">
                            <div class="profile-nickname">${userInfo.nickname}</div>
                            <div class="profile-status ${userProfile.status === 'online' ? 'online' : 'offline'}">
                                ${userProfile.status === 'online' ? 'Online' : 'Offline'}
                            </div>
                        </div>
                    </div>
                    
                    <div class="profile-section">
                        <h3 class="section-title">Personal Information</h3>
                        <div class="form-group">
                            <label for="profile-display-name">Display Name:</label>
                            <input type="text" id="profile-display-name" class="win95-input" value="${userProfile.displayName}">
                        </div>
                        <div class="form-group">
                            <label for="profile-bio">Bio:</label>
                            <textarea id="profile-bio" class="win95-textarea" rows="3">${userProfile.bio}</textarea>
                        </div>
                    </div>
                    
                    <div class="profile-section">
                        <h3 class="section-title">Appearance</h3>
                        <div class="form-group">
                            <label for="profile-avatar-color">Avatar Color:</label>
                            <div class="color-picker">
                                <div class="color-option" data-color="#007BFF" style="background-color: #007BFF;"></div>
                                <div class="color-option" data-color="#28A745" style="background-color: #28A745;"></div>
                                <div class="color-option" data-color="#DC3545" style="background-color: #DC3545;"></div>
                                <div class="color-option" data-color="#FFC107" style="background-color: #FFC107;"></div>
                                <div class="color-option" data-color="#6C757D" style="background-color: #6C757D;"></div>
                                <div class="color-option" data-color="#17A2B8" style="background-color: #17A2B8;"></div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Buddy Icon:</label>
                            <div class="avatar-icon-preview" id="avatar-icon-preview">
                                ${userProfile.avatarIcon
                                    ? `<img src="${escapeHtml(userProfile.avatarIcon)}" alt="avatar">`
                                    : `<span class="avatar-icon-placeholder">${escapeHtml(userInfo.nickname.charAt(0).toUpperCase())}</span>`}
                            </div>
                            <input type="hidden" id="profile-avatar-icon-data" value="${escapeHtml(userProfile.avatarIcon || '')}">
                            <div class="avatar-icon-actions">
                                <label class="win95-button">
                                    Upload
                                    <input type="file" id="profile-avatar-upload" accept="image/png,image/jpeg,image/gif" hidden>
                                </label>
                                <button type="button" class="win95-button" id="profile-avatar-clear">Use Initial</button>
                            </div>
                            <div class="form-hint">Pick a preset or upload PNG/JPEG/GIF (max 2 MB, auto-resized to 64×64).</div>
                            <div class="avatar-preset-grid" id="avatar-preset-grid">
                                <div class="loading">Loading presets…</div>
                            </div>
                            <div class="form-error" id="avatar-upload-error"></div>
                        </div>
                        <div class="form-group">
                            <label for="profile-status">Status:</label>
                            <select id="profile-status" class="win95-input">
                                <option value="online"    ${userProfile.status === 'online'    ? 'selected' : ''}>● Online</option>
                                <option value="away"      ${userProfile.status === 'away'      ? 'selected' : ''}>◐ Away</option>
                                <option value="invisible" ${userProfile.status === 'invisible' ? 'selected' : ''}>○ Invisible</option>
                                <option value="offline"   ${userProfile.status === 'offline'   ? 'selected' : ''}>✕ Offline</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="profile-away-message">Away Message:</label>
                            <textarea id="profile-away-message" class="win95-textarea" rows="3"
                                placeholder="Brb, getting pizza rolls 🍕"
                            >${escapeHtml(userProfile.awayMessage || '')}</textarea>
                            <div class="form-hint">
                                Sent as an auto-reply when someone DMs you while you're set to Away.
                                <a href="#" id="away-suggestion-cycle">Try a suggestion</a>
                            </div>
                        </div>
                    </div>
                    
                    <div class="profile-section">
                        <h3 class="section-title">Notification Settings</h3>
                        <div class="form-group">
                            <label for="profile-sound-pack">Sound Pack:</label>
                            <select id="profile-sound-pack" class="win95-input">
                                ${Object.entries(window.AIM_SOUND_PACKS).map(([id, p]) =>
                                    `<option value="${id}" ${(userProfile.soundPack || 'classic') === id ? 'selected' : ''}>${p.label}</option>`
                                ).join('')}
                            </select>
                        </div>
                        <div class="form-group checkbox-group">
                            <label class="win95-checkbox">
                                <input type="checkbox" id="profile-sound-enabled" ${userProfile.soundEnabled ? 'checked' : ''}>
                                Enable sound notifications
                            </label>
                        </div>
                        <div class="form-group checkbox-group">
                            <label class="win95-checkbox">
                                <input type="checkbox" id="profile-typing-indicator" ${userProfile.typingIndicator ? 'checked' : ''}>
                                Show when I'm typing
                            </label>
                        </div>
                    </div>

                    <div class="profile-section">
                        <h3 class="section-title">Game Record</h3>
                        <div class="profile-stats" id="profile-stats">
                            <div class="loading">Loading stats…</div>
                        </div>
                    </div>

                    <div class="profile-actions">
                        <button class="win95-button" id="profile-save-button">Save Changes</button>
                        <button class="win95-button" id="profile-cancel-button">Cancel</button>
                    </div>
                </div>
            </div>
        `;

        document.querySelector('.win95-container').appendChild(profileWindow);
        makeWindowsDraggable();
        loadStatsInto('#profile-stats', userInfo.nickname);

        // Avatar icon picker / uploader (Phase 3.2). The hidden input
        // #profile-avatar-icon-data is the source of truth; everything below
        // just writes to it. The save handler reads it.
        const avatarPreview = profileWindow.querySelector('#avatar-icon-preview');
        const avatarHidden  = profileWindow.querySelector('#profile-avatar-icon-data');
        const avatarUpload  = profileWindow.querySelector('#profile-avatar-upload');
        const avatarClear   = profileWindow.querySelector('#profile-avatar-clear');
        const avatarErr     = profileWindow.querySelector('#avatar-upload-error');
        const avatarGrid    = profileWindow.querySelector('#avatar-preset-grid');

        const setAvatar = (dataUrl) => {
            avatarHidden.value = dataUrl || '';
            if (dataUrl) {
                avatarPreview.innerHTML = `<img src="${dataUrl}" alt="avatar">`;
            } else {
                avatarPreview.innerHTML = `<span class="avatar-icon-placeholder">${escapeHtml(userInfo.nickname.charAt(0).toUpperCase())}</span>`;
            }
        };

        avatarUpload.addEventListener('change', async () => {
            avatarErr.textContent = '';
            const file = avatarUpload.files && avatarUpload.files[0];
            if (!file) return;
            try {
                const dataUrl = await fileToPngDataUrl(file);
                setAvatar(dataUrl);
            } catch (err) {
                avatarErr.textContent = err.message || 'Upload failed';
            } finally {
                avatarUpload.value = ''; // allow re-picking the same file
            }
        });

        avatarClear.addEventListener('click', () => {
            setAvatar('');
        });

        // Render presets — runs SVGs through canvas to get PNG data URLs.
        Promise.all(AIM_AVATAR_PRESET_SVGS.map(svgToPngDataUrl)).then(pngs => {
            avatarGrid.innerHTML = pngs.filter(Boolean).map(png => `
                <button type="button" class="avatar-preset" data-url="${png}">
                    <img src="${png}" alt="preset">
                </button>
            `).join('');
            avatarGrid.querySelectorAll('.avatar-preset').forEach(btn => {
                btn.addEventListener('click', () => setAvatar(btn.getAttribute('data-url')));
            });
        });

        // Away-message suggestion cycle — clicking the inline link cycles
        // through a small grab-bag of period-correct away messages so users
        // don't have to write one from scratch.
        const AWAY_SUGGESTIONS = [
            'Brb, getting pizza rolls 🍕',
            'AFK — see ya at 8!',
            'In class, talk later',
            'Cyaaa later! 👋',
            'On the other line, brb',
            'Mom said dinner — bbiab',
            'GTG, see you tomorrow!',
            'Out skating, back soon ⛸️',
            'On the phone — leave a msg',
            "Reading, don't bother me ;P",
        ];
        let awaySuggestionIdx = 0;
        const awayCycleLink = profileWindow.querySelector('#away-suggestion-cycle');
        const awayMsgEl = profileWindow.querySelector('#profile-away-message');
        if (awayCycleLink && awayMsgEl) {
            awayCycleLink.addEventListener('click', (e) => {
                e.preventDefault();
                awayMsgEl.value = AWAY_SUGGESTIONS[awaySuggestionIdx % AWAY_SUGGESTIONS.length];
                awaySuggestionIdx++;
                awayMsgEl.focus();
            });
        }
        
        // Set up color picker
        const colorOptions = profileWindow.querySelectorAll('.color-option');
        colorOptions.forEach(option => {
            const color = option.dataset.color;
            if (color === userProfile.avatarColor) {
                option.classList.add('selected');
            }
            
            option.addEventListener('click', () => {
                // Remove selected class from all options
                colorOptions.forEach(o => o.classList.remove('selected'));
                // Add selected class to clicked option
                option.classList.add('selected');
                // Update avatar color
                profileWindow.querySelector('.profile-avatar').style.backgroundColor = color;
            });
        });
        
        // Set up save button
        profileWindow.querySelector('#profile-save-button').addEventListener('click', () => {
            // Get form values
            const displayName = profileWindow.querySelector('#profile-display-name').value.trim();
            const bio = profileWindow.querySelector('#profile-bio').value.trim();
            const avatarColor = profileWindow.querySelector('.color-option.selected').dataset.color;
            const statusEl = profileWindow.querySelector('input[name="status"]:checked')
                              || profileWindow.querySelector('#profile-status');
            const status = statusEl
                ? (statusEl.tagName === 'SELECT' ? statusEl.value : statusEl.value)
                : 'online';
            const soundEnabled = profileWindow.querySelector('#profile-sound-enabled').checked;
            const typingIndicator = profileWindow.querySelector('#profile-typing-indicator').checked;
            const soundPack = profileWindow.querySelector('#profile-sound-pack').value;
            const awayMessageEl = profileWindow.querySelector('#profile-away-message');
            const awayMessage = awayMessageEl ? awayMessageEl.value.trim() : '';
            const avatarIconEl = profileWindow.querySelector('#profile-avatar-icon-data');
            const avatarIcon = avatarIconEl ? avatarIconEl.value || null : (userProfile.avatarIcon || null);

            // Save profile
            saveUserProfile({
                displayName,
                bio,
                avatarColor,
                avatarIcon,
                status,
                soundEnabled,
                typingIndicator,
                soundPack,
                awayMessage,
            });

            // Update UI
            updateProfileUI();
            // Push the new status/avatar to other clients via the existing WS update.

            // Show confirmation message
            alert('Profile updated successfully!');
        });
        
        // Set up cancel button
        profileWindow.querySelector('#profile-cancel-button').addEventListener('click', () => {
            profileWindow.style.display = 'none';
        });
    } else {
        profileWindow.style.display = 'flex';
        // Refresh stats on every re-open so freshly finished games show up.
        loadStatsInto('#profile-stats', userInfo.nickname);
    }

    showWindow('profile-window');
}

// Profile storage is scoped by signed-in nickname so multiple accounts
// sharing the same browser don't bleed each other's profiles. The legacy
// unscoped 'userProfile' key is migrated once on first read.
function profileStorageKey() {
    const me = (typeof userInfo !== 'undefined' && userInfo.nickname) ? userInfo.nickname : 'anon';
    return 'aim_profile_' + me;
}

function getUserProfile() {
    const key = profileStorageKey();
    let stored = localStorage.getItem(key);

    // One-time migration: if we haven't saved a scoped profile yet but the
    // legacy unscoped key exists AND it belongs to the current user, adopt
    // it and remove the legacy. If the legacy belongs to a different user,
    // leave it in place so that user's next sign-in can still migrate it —
    // only delete it after a successful adoption to avoid wiping data.
    if (!stored) {
        const legacy = localStorage.getItem('userProfile');
        if (legacy) {
            try {
                const p = JSON.parse(legacy);
                if (p && (!p.displayName || p.displayName === userInfo.nickname)) {
                    localStorage.setItem(key, legacy);
                    stored = legacy;
                    try { localStorage.removeItem('userProfile'); } catch (_) {}
                }
            } catch (_) { /* ignore malformed legacy */ }
        }
    }

    if (stored) {
        try {
            const p = JSON.parse(stored);
            // Defensive: if the stored displayName looks like a different
            // account, fall back to the current nickname.
            if (p && typeof p === 'object') {
                if (!p.displayName) p.displayName = userInfo.nickname;
                return p;
            }
        } catch (_) { /* fall through to default */ }
    }

    return {
        displayName: userInfo.nickname,
        bio: 'I love chatting in Windows 95 style!',
        avatarColor: '#007BFF',
        avatarIcon: null,
        status: 'online',
        awayMessage: '',
        soundEnabled: true,
        typingIndicator: true,
        soundPack: 'classic',
        wallpaper: 'teal',
    };
}

function saveUserProfile(profile) {
    localStorage.setItem(profileStorageKey(), JSON.stringify(profile));

    // Send profile update to server
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'update_profile',
            nickname: userInfo.nickname,
            displayName: profile.displayName,
            status: profile.status,
            avatarColor: profile.avatarColor,
            profile: profile
        }));
    }

    // Persist to Bluehost SQLite so settings follow the user across devices.
    // Maps the localStorage keys (camelCase) onto the SQLite column names
    // (snake_case). Fire-and-forget — localStorage is the fast read cache.
    window.apiPost('save-profile', {
        display_name:     profile.displayName,
        bio:              profile.bio,
        avatar_color:     profile.avatarColor,
        avatar_icon:      profile.avatarIcon || null,
        away_message:     profile.awayMessage || null,
        status:           profile.status,
        sound_pack:       profile.soundPack || 'classic',
        sound_enabled:    !!profile.soundEnabled,
        typing_indicator: !!profile.typingIndicator,
    }).then(r => r.json())
      .then(data => {
          if (!data || !data.success) {
              console.warn('save-profile rejected:', data && data.error);
          }
      })
      .catch(err => console.warn('save-profile network error:', err));
}

// Hydrate the local profile cache from the SQLite-backed profiles table so
// changes made in another browser show up here too. Falls back silently if
// the request fails — the existing localStorage cache is good enough.
function refreshProfileFromServer() {
    fetch('backend.php?endpoint=get-profile', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => {
            if (!data || !data.success || !data.profile) return;
            const p = data.profile;
            // Map server column names back into the localStorage shape used
            // everywhere else in script.js.
            const merged = {
                displayName:     p.display_name  || userInfo.nickname,
                bio:             p.bio           || 'I love chatting in Windows 95 style!',
                avatarColor:     p.avatar_color  || '#007BFF',
                avatarIcon:      p.avatar_icon   || null,
                awayMessage:     p.away_message  || '',
                status:          p.status        || 'online',
                soundPack:       p.sound_pack    || 'classic',
                soundEnabled:    p.sound_enabled !== false,
                typingIndicator: p.typing_indicator !== false,
            };
            localStorage.setItem(profileStorageKey(), JSON.stringify(merged));
            // Re-render any open profile UI with the fresh values.
            updateProfileUI();
        })
        .catch(err => console.warn('refreshProfileFromServer failed:', err));
}

function updateProfileUI() {
    // Update UI based on profile settings
    const profile = getUserProfile();
    
    // Update user avatar in active now window if it exists
    const activeNowWindow = document.getElementById('active-now-window');
    if (activeNowWindow) {
        const userItems = activeNowWindow.querySelectorAll('.active-user-item');
        userItems.forEach(item => {
            const userName = item.querySelector('.user-name');
            if (userName && userName.textContent.includes(userInfo.nickname)) {
                // Update status
                const statusElement = item.querySelector('.user-status');
                if (statusElement) {
                    statusElement.className = `user-status ${profile.status}`;
                }
                
                // Update display name and avatar
                const displayText = profile.displayName !== userInfo.nickname 
                    ? `${profile.displayName} (${userInfo.nickname})` 
                    : userInfo.nickname;
                
                userName.textContent = displayText;
                
                // Update avatar color
                const avatar = item.querySelector('.user-avatar');
                if (avatar) {
                    avatar.style.backgroundColor = profile.avatarColor;
                }
            }
        });
    }
    
    // Apply sound settings
    if (!profile.soundEnabled) {
        // Mute all sounds
        document.querySelectorAll('audio').forEach(audio => {
            audio.muted = true;
        });
    } else {
        // Unmute all sounds
        document.querySelectorAll('audio').forEach(audio => {
            audio.muted = false;
        });
    }
    
    // Recreate Active Now window to reflect changes
    const oldActiveNow = document.getElementById('active-now-window');
    if (oldActiveNow && oldActiveNow.style.display !== 'none' && oldActiveNow.style.display !== '') {
        oldActiveNow.remove();
        showActiveNowWindow();
    }
}

// Active-users polling was removed in favor of the WS roster broadcast +
// per-window request_roster nudges. Two refresh sources caused the buddy
// list to flicker users on/off. Keeping these vars only to avoid breaking
// any out-of-tree code that might check them.
let activeUsersRefreshInterval = null;
const REFRESH_INTERVAL = 10000;

function showActiveNowWindow() {
    let activeNowWindow = document.getElementById('active-now-window');

    if (!activeNowWindow) {
        activeNowWindow = document.createElement('div');
        activeNowWindow.id = 'active-now-window';
        activeNowWindow.className = 'window buddy-list-window';
        activeNowWindow.style.width = '290px';
        activeNowWindow.style.height = '440px';
        activeNowWindow.style.top = '90px';
        activeNowWindow.style.left = '200px';

        activeNowWindow.innerHTML = `
            <div class="window-header">
                <div class="window-title">Buddy List</div>
                <div class="window-controls">
                    <button class="control-button minimize" type="button">-</button>
                    <button class="control-button maximize" type="button">□</button>
                    <button class="control-button close" type="button">×</button>
                </div>
            </div>
            <div class="window-content buddy-list-content">
                <div class="buddy-toolbar">
                    <button class="win95-button buddy-toolbar-btn" id="buddy-add-btn" type="button" title="Add a buddy by screen name">
                        <img src="images/add-buddy.png" alt=""><span>Add</span>
                    </button>
                    <button class="win95-button buddy-toolbar-btn" id="buddy-remove-btn" type="button" title="Remove a buddy">
                        <img src="images/remove-buddy.png" alt=""><span>Remove</span>
                    </button>
                    <span class="buddy-toolbar-spacer"></span>
                    <button class="win95-button refresh-users-btn icon-only" type="button" title="Refresh now">&#x21bb;</button>
                </div>
                <div class="buddy-stats" id="buddy-stats">
                    <span class="buddy-stats-chip" id="buddy-stats-buddies">★ 0 Buddies</span>
                    <span class="buddy-stats-chip" id="buddy-stats-active">● 0 Active</span>
                </div>
                <div class="active-users-list" id="active-users-list">
                    <div class="loading">Loading buddy list&hellip;</div>
                </div>
                <div class="buddy-statusbar">
                    <span id="buddy-statusbar-text">&nbsp;</span>
                </div>
            </div>
        `;

        document.querySelector('.win95-container').appendChild(activeNowWindow);
        makeWindowsDraggable();

        activeNowWindow.querySelector('.refresh-users-btn').addEventListener('click', requestRosterRefresh);
        activeNowWindow.querySelector('#buddy-add-btn').addEventListener('click', () => showAddBuddyDialog());
        activeNowWindow.querySelector('#buddy-remove-btn').addEventListener('click', () => showRemoveBuddyDialog());
    } else {
        activeNowWindow.style.display = 'flex';
    }

    showWindow('active-now-window');

    // Ask the server to push a fresh roster immediately so the window
    // doesn't sit on stale data until the next 15s broadcast tick. The
    // previous design polled HTTP every 10s here, which fought the WS
    // broadcast and caused the buddy list to flicker users on/off.
    requestRosterRefresh();

    // Paint immediately from whatever we already have so the user isn't
    // staring at a "Loading…" message while the request_roster round-trips.
    if (lastUsersSnapshot && lastUsersSnapshot.length) {
        updateActiveUsersList(lastUsersSnapshot);
    }
}

// Request a fresh active-users roster from the WS server. The server is
// the only authority on "who's connected" since it holds the live socket
// map; the HTTP active-users endpoint is now only a cold-start fallback.
// Deliberately NO http fallback here — if WS is down, populating from
// HTTP and then getting a (potentially different) WS push 2s later is
// exactly the flicker we just fixed.
function requestRosterRefresh() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'request_roster' }));
    }
}

// ---------- Add / Remove buddy dialogs ----------
// Both dialogs are Win95-style modals built lazily on first use and reused.
// They append to .win95-container so they ride on top of everything.
function ensureBuddyDialog(id, build) {
    let dlg = document.getElementById(id);
    if (dlg) return dlg;
    dlg = document.createElement('div');
    dlg.id = id;
    dlg.className = 'window dialog buddy-dialog';
    dlg.style.display = 'none';
    dlg.style.width = '320px';
    dlg.innerHTML = build();
    document.querySelector('.win95-container').appendChild(dlg);
    makeWindowsDraggable();
    return dlg;
}

function showAddBuddyDialog(prefillNick) {
    const dlg = ensureBuddyDialog('add-buddy-dialog', () => `
        <div class="window-header">
            <div class="window-title">Add Buddy</div>
            <div class="window-controls">
                <button class="control-button close" type="button">×</button>
            </div>
        </div>
        <div class="window-content">
            <div class="buddy-dialog-body">
                <img src="images/add-buddy.png" class="buddy-dialog-icon" alt="">
                <div class="buddy-dialog-form">
                    <label for="add-buddy-input" class="buddy-dialog-prompt">
                        Type the screen name of the buddy you'd like to add:
                    </label>
                    <input type="text" id="add-buddy-input" class="win95-input" maxlength="32" autocomplete="off">
                    <div class="form-error" id="add-buddy-error"></div>
                </div>
            </div>
            <div class="dialog-buttons">
                <button class="win95-button primary-button" id="add-buddy-confirm" type="button">Add</button>
                <button class="win95-button" id="add-buddy-cancel" type="button">Cancel</button>
            </div>
        </div>
    `);

    const input = dlg.querySelector('#add-buddy-input');
    const error = dlg.querySelector('#add-buddy-error');
    const confirm = dlg.querySelector('#add-buddy-confirm');
    const cancel = dlg.querySelector('#add-buddy-cancel');
    const close  = dlg.querySelector('.control-button.close');

    input.value = prefillNick || '';
    error.textContent = '';

    const closeDialog = () => { dlg.style.display = 'none'; };
    const submit = () => {
        const nick = input.value.trim();
        if (!nick) { error.textContent = 'Please enter a screen name.'; return; }
        if (nick === userInfo.nickname) { error.textContent = "You can't add yourself."; return; }
        if (isBuddy(nick)) { error.textContent = `${nick} is already on your buddy list.`; return; }
        addBuddy(nick);
        playSound('buddyin-sound');
        setBuddyStatus(`Added ${nick} to your buddy list.`);
        updateActiveUsersList(lastUsersSnapshot);
        closeDialog();
    };

    // Re-bind handlers each open (overwrites previous bindings).
    confirm.onclick = submit;
    cancel.onclick  = closeDialog;
    close.onclick   = closeDialog;
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    };

    dlg.style.display = 'flex';
    bringToFront(dlg);
    setTimeout(() => input.focus(), 50);
}

function showRemoveBuddyDialog() {
    const buddies = getBuddies();
    if (buddies.length === 0) {
        setBuddyStatus('You have no buddies to remove yet.');
        showAddBuddyDialog(); // friendly nudge — open Add instead
        return;
    }

    const dlg = ensureBuddyDialog('remove-buddy-dialog', () => `
        <div class="window-header">
            <div class="window-title">Remove Buddy</div>
            <div class="window-controls">
                <button class="control-button close" type="button">×</button>
            </div>
        </div>
        <div class="window-content">
            <div class="buddy-dialog-body">
                <img src="images/remove-buddy.png" class="buddy-dialog-icon" alt="">
                <div class="buddy-dialog-form">
                    <label for="remove-buddy-select" class="buddy-dialog-prompt">
                        Pick a buddy to remove from your list:
                    </label>
                    <select id="remove-buddy-select" class="win95-input"></select>
                    <div class="form-error" id="remove-buddy-error"></div>
                </div>
            </div>
            <div class="dialog-buttons">
                <button class="win95-button primary-button" id="remove-buddy-confirm" type="button">Remove</button>
                <button class="win95-button" id="remove-buddy-cancel" type="button">Cancel</button>
            </div>
        </div>
    `);

    const select  = dlg.querySelector('#remove-buddy-select');
    const error   = dlg.querySelector('#remove-buddy-error');
    const confirm = dlg.querySelector('#remove-buddy-confirm');
    const cancel  = dlg.querySelector('#remove-buddy-cancel');
    const close   = dlg.querySelector('.control-button.close');

    select.innerHTML = buddies
        .slice()
        .sort((a, b) => a.localeCompare(b))
        .map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
        .join('');
    error.textContent = '';

    const closeDialog = () => { dlg.style.display = 'none'; };
    const submit = () => {
        const nick = select.value;
        if (!nick) { error.textContent = 'Pick a buddy first.'; return; }
        removeBuddyEntry(nick);
        playSound('buddyout-sound');
        setBuddyStatus(`Removed ${nick} from your buddy list.`);
        updateActiveUsersList(lastUsersSnapshot);
        closeDialog();
    };

    confirm.onclick = submit;
    cancel.onclick  = closeDialog;
    close.onclick   = closeDialog;
    select.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    };

    dlg.style.display = 'flex';
    bringToFront(dlg);
    setTimeout(() => select.focus(), 50);
}

// Small helper to update the Buddy List statusbar (bottom strip).
function setBuddyStatus(text) {
    const el = document.getElementById('buddy-statusbar-text');
    if (el) {
        el.textContent = text;
        // Fade back to a neutral message after a few seconds.
        clearTimeout(setBuddyStatus._t);
        setBuddyStatus._t = setTimeout(() => {
            if (el.textContent === text) el.textContent = ' ';
        }, 4000);
    }
}

// ---------- Buddy list (server-backed) ----------
// Buddies live in the SQLite `buddies` table (server-side) so the list
// follows the user across devices and browsers. The in-memory cache below
// makes reads synchronous (the buddy-list UI re-renders frequently), and
// localStorage holds a snapshot so the UI is correct on a cold reload
// before the network fetch completes.
let buddiesCache = [];
let buddiesLoaded = false;

function buddyStorageKey() {
    const me = (typeof userInfo !== 'undefined' && userInfo.nickname) ? userInfo.nickname : 'anon';
    return 'aim_buddies_' + me;
}

function getBuddies() {
    if (buddiesLoaded) return buddiesCache.slice();
    // Cold start fallback: hydrate from the localStorage snapshot so the
    // first render after page load isn't empty.
    try {
        const raw = localStorage.getItem(buddyStorageKey());
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr)) buddiesCache = arr;
    } catch (_) {}
    return buddiesCache.slice();
}

function isBuddy(nick) { return getBuddies().includes(nick); }

function setBuddies(list) {
    buddiesCache = list.slice();
    try { localStorage.setItem(buddyStorageKey(), JSON.stringify(buddiesCache)); } catch (_) {}
}

// Initial load from the server. Called from initializeDesktop() after the
// signed-in user is known. Refreshes the buddy list UI if it's already open.
function loadBuddiesFromBackend() {
    fetch('backend.php?endpoint=buddies', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => {
            if (data && data.success) {
                buddiesCache = Array.isArray(data.buddies) ? data.buddies : [];
                buddiesLoaded = true;
                try { localStorage.setItem(buddyStorageKey(), JSON.stringify(buddiesCache)); } catch (_) {}
                if (lastUsersSnapshot && lastUsersSnapshot.length) {
                    updateActiveUsersList(lastUsersSnapshot);
                }
            }
        })
        .catch(err => {
            console.warn('Buddies load failed, falling back to local snapshot:', err);
            buddiesLoaded = true; // mark loaded so the cache is treated as authoritative
        });
}

// Optimistic add: update the cache first so the UI reflects the change
// immediately, then POST to the server. On failure, roll back and surface
// the error in the statusbar.
function addBuddy(nick) {
    if (!nick) return;
    if (!buddiesCache.includes(nick)) {
        buddiesCache.push(nick);
        try { localStorage.setItem(buddyStorageKey(), JSON.stringify(buddiesCache)); } catch (_) {}
    }
    window.apiPost('add-buddy', { nickname: nick })
        .then(r => r.json())
        .then(d => {
            if (!d || !d.success) {
                const msg = (d && d.error) ? d.error : 'server error';
                console.warn('add-buddy rejected:', msg);
                buddiesCache = buddiesCache.filter(n => n !== nick);
                try { localStorage.setItem(buddyStorageKey(), JSON.stringify(buddiesCache)); } catch (_) {}
                if (typeof setBuddyStatus === 'function') setBuddyStatus('Could not save buddy: ' + msg);
                if (lastUsersSnapshot && lastUsersSnapshot.length) updateActiveUsersList(lastUsersSnapshot);
            }
        })
        .catch(err => {
            console.warn('add-buddy network error:', err);
            // Network blip — leave the optimistic add in place; will reconcile on next load.
        });
}

function removeBuddyEntry(nick) {
    if (!nick) return;
    const had = buddiesCache.includes(nick);
    buddiesCache = buddiesCache.filter(n => n !== nick);
    try { localStorage.setItem(buddyStorageKey(), JSON.stringify(buddiesCache)); } catch (_) {}
    window.apiPost('remove-buddy', { nickname: nick })
        .then(r => r.json())
        .then(d => {
            if (!d || !d.success) {
                const msg = (d && d.error) ? d.error : 'server error';
                console.warn('remove-buddy rejected:', msg);
                if (had && !buddiesCache.includes(nick)) {
                    buddiesCache.push(nick);
                    try { localStorage.setItem(buddyStorageKey(), JSON.stringify(buddiesCache)); } catch (_) {}
                }
                if (typeof setBuddyStatus === 'function') setBuddyStatus('Could not remove buddy: ' + msg);
                if (lastUsersSnapshot && lastUsersSnapshot.length) updateActiveUsersList(lastUsersSnapshot);
            }
        })
        .catch(err => {
            console.warn('remove-buddy network error:', err);
        });
}
// Last roster passed through updateActiveUsersList, so the buddy toggle can
// re-render without re-fetching from the server.
let lastUsersSnapshot = [];

// Click handler for the per-row add/remove buddy buttons. Wired with event
// delegation in showActiveNowWindow().
window.handleBuddyToggle = function (btn) {
    const nick = btn.getAttribute('data-nick');
    const action = btn.getAttribute('data-action');
    if (!nick) return;
    if (action === 'add') {
        addBuddy(nick);
        playSound('buddyin-sound');
        if (typeof setBuddyStatus === 'function') setBuddyStatus(`Added ${nick} to your buddy list.`);
    } else {
        removeBuddyEntry(nick);
        playSound('buddyout-sound');
        if (typeof setBuddyStatus === 'function') setBuddyStatus(`Removed ${nick} from your buddy list.`);
    }
    updateActiveUsersList(lastUsersSnapshot);
};

// Cold-start fallback only. Called once on init if no WS active_users push
// has arrived within 2s. After WS has been seen (rosterSnapshot !== null),
// this is a no-op so HTTP data can't overwrite the authoritative WS roster
// and cause the buddy list to flicker. The WS handler in connectToWebSocket
// is the steady-state update path.
function fetchActiveUsers() {
    if (rosterSnapshot !== null) return;  // WS already won — don't fight it

    const activeUsersList = document.querySelector('#active-now-window .active-users-list');
    if (activeUsersList && (activeUsersList.innerHTML === '' || activeUsersList.innerHTML.includes('Loading buddy list'))) {
        activeUsersList.innerHTML = '<div class="loading">Loading buddy list...</div>';
    }

    fetch('backend.php?endpoint=active-users')
        .then(r => r.json())
        .then(data => {
            if (rosterSnapshot !== null) return;  // race: WS came in while we were fetching
            if (!data || !data.success) {
                if (activeUsersList) activeUsersList.innerHTML = '<div class="loading error">Failed to load buddy list</div>';
                return;
            }
            updateActiveUsersList(data.users);
            const userCount = document.querySelector('#active-users-icon .user-count');
            if (userCount) userCount.textContent = data.users.length;
        })
        .catch(err => {
            console.warn('Cold-start active-users fetch failed:', err);
        });
}

function updateActiveUsersList(users) {
    console.log('Updating active users list with:', users);
    const activeUsersList = document.querySelector('#active-now-window .active-users-list');
    if (!activeUsersList) {
        console.error('Active users list element not found');
        return;
    }

    if (!users || users.length === 0) {
        lastUsersSnapshot = [];
        activeUsersList.innerHTML = '<div class="loading">No buddies online</div>';
        return;
    }

    // Cache the roster so the per-row add/remove buttons can re-render
    // without a network round-trip.
    lastUsersSnapshot = users.slice();

    const userProfile = getUserProfile();
    const buddies = getBuddies();

    // Split into Buddies (online buddies) and Online (everyone else).
    // Current user is rendered as a small "Me" section at the bottom so
    // the buddy/online lists read cleanly.
    const me      = users.find(u => u.nickname === userInfo.nickname);
    const others  = users.filter(u => u.nickname !== userInfo.nickname);
    const sortByName = (a, b) => a.nickname.localeCompare(b.nickname);
    const buddyRows  = others.filter(u => buddies.includes(u.nickname)).sort(sortByName);
    const onlineRows = others.filter(u => !buddies.includes(u.nickname)).sort(sortByName);

    // Buddies the user has added but who aren't currently online — synthesized
    // entries so the buddy list still shows them (greyed out).
    const onlineNicks = new Set(others.map(u => u.nickname));
    const offlineBuddyRows = buddies
        .filter(n => n !== userInfo.nickname && !onlineNicks.has(n))
        .sort()
        .map(n => ({ nickname: n, status: 'offline', avatarColor: '#808080' }));

    // For the unified renderer below, ordered: buddies online, buddies offline, everyone else, me.
    const sorted = [].concat(
        buddyRows.map(u => ({ ...u, __section: 'buddies' })),
        offlineBuddyRows.map(u => ({ ...u, __section: 'buddies' })),
        onlineRows.map(u => ({ ...u, __section: 'online' })),
        me ? [{ ...me, __section: 'me' }] : []
    );

    // Build section headers inline so users get the classic AIM "Buddies / Online" split.
    // "Active Users" is the prominent section showing everyone currently online
    // who isn't already on your buddy list — quick to scan and easy to add.
    const html = [];
    let lastSection = null;
    const onlineBuddyCount = buddyRows.length;
    const totalBuddyCount = onlineBuddyCount + offlineBuddyRows.length;
    const sectionLabel = {
        buddies: `★ Buddies <span class="buddy-section-count">${onlineBuddyCount} online · ${totalBuddyCount} total</span>`,
        online:  `● Active Users <span class="buddy-section-count">${onlineRows.length} online</span>`,
        me:      'You'
    };

    // Update the top-of-window stats chips. Buddies = total saved; Active = everyone online (including you).
    const buddyCountEl = document.getElementById('buddy-stats-buddies');
    const activeCountEl = document.getElementById('buddy-stats-active');
    if (buddyCountEl) buddyCountEl.textContent = `★ ${onlineBuddyCount}/${totalBuddyCount} Buddies`;
    if (activeCountEl) activeCountEl.textContent = `● ${users.length} Active`;

    sorted.forEach(user => {
        // Emit a section header when the section changes.
        if (user.__section !== lastSection) {
            lastSection = user.__section;
            html.push(`<div class="buddy-section-header buddy-section-${lastSection}">${sectionLabel[lastSection]}</div>`);
        }

        const isCurrentUser = user.nickname === userInfo.nickname;
        const isBud = buddies.includes(user.nickname);
        const displayName = isCurrentUser ? userProfile.displayName : user.nickname;
        const avatarColor = isCurrentUser ? userProfile.avatarColor : (user.avatarColor || '#007BFF');
        const avatarIcon  = isCurrentUser ? userProfile.avatarIcon  : (user.avatarIcon || null);
        const status = isCurrentUser ? userProfile.status : (user.status || 'online');
        const safeNick = escapeHtml(user.nickname);
        const isOffline = status === 'offline';

        const buddyToggle = isCurrentUser ? '' : `
            <button class="buddy-toggle-btn"
                    data-nick="${safeNick}"
                    data-action="${isBud ? 'remove' : 'add'}"
                    title="${isBud ? 'Remove from buddies' : 'Add to buddies'}"
                    onclick="event.stopPropagation(); handleBuddyToggle(this)">
                <img src="images/${isBud ? 'remove' : 'add'}-buddy.png"
                     alt="${isBud ? 'Remove buddy' : 'Add buddy'}">
            </button>
        `;

        // Don't show a Message button for offline buddies — DMs can't be delivered.
        const messageBtn = (!isCurrentUser && !isOffline) ? `
            <button class="win95-button message-button" onclick="showDirectMessageWindow('${safeNick}')">
                IM
            </button>
        ` : '';

        // Challenge dropdown — opens a menu of games. Offline buddies can't
        // be challenged (server-side they wouldn't receive the invite).
        const challengeBtn = (!isCurrentUser && !isOffline) ? `
            <button class="win95-button challenge-button"
                    title="Challenge to a game"
                    onclick="event.stopPropagation(); handleChallengeClick(this, '${safeNick}')">
                🎮 ▾
            </button>
        ` : '';

        const avatarInner = avatarIcon
            ? `<img class="user-avatar-img" src="${escapeHtml(avatarIcon)}" alt="">`
            : displayName.charAt(0).toUpperCase();
        html.push(`
            <div class="active-user-item${isBud ? ' is-buddy' : ''}${isCurrentUser ? ' is-self' : ''}${isOffline ? ' is-offline' : ''}">
                <div class="user-avatar" style="background-color: ${avatarColor}">
                    ${avatarInner}
                    <div class="user-status ${status}"></div>
                </div>
                <div class="user-info">
                    <div class="user-name clickable-nick" data-nick="${safeNick}">${escapeHtml(displayName)}${isCurrentUser ? ' (You)' : ''}</div>
                    <div class="user-status-text">${isOffline ? 'Offline' : (isBud ? 'Buddy' : 'Online')}</div>
                </div>
                ${buddyToggle}
                ${challengeBtn}
                ${messageBtn}
            </div>
        `);
    });

    activeUsersList.innerHTML = html.join('');
}

// Direct message functions
function showDirectMessageWindow(recipient) {
    let sanitizedRecipient = recipient.replace(/[^a-zA-Z0-9]/g, '');
    let windowId = `dm-window-${sanitizedRecipient}`;
    let dmWindow = document.getElementById(windowId);
    
    console.log(`Creating DM window for ${recipient}, windowId: ${windowId}`);
    
    if (!dmWindow) {
        // Create new DM window
        dmWindow = document.createElement('div');
        dmWindow.id = windowId;
        dmWindow.className = 'window direct-message-window';
        dmWindow.dataset.recipient = recipient;
        dmWindow.style.width = '350px';
        dmWindow.style.height = '300px';
        
        // Calculate position to avoid stacking windows directly on top of each other
        const existingWindows = document.querySelectorAll('.direct-message-window').length;
        dmWindow.style.top = `${100 + existingWindows * 20}px`;
        dmWindow.style.left = `${120 + existingWindows * 20}px`;
        
        dmWindow.innerHTML = `
            <div class="window-header">
                <div class="window-title">Chat with ${recipient}</div>
                <div class="window-controls">
                    <button class="control-button minimize">-</button>
                    <button class="control-button maximize">□</button>
                    <button class="control-button close">×</button>
                </div>
            </div>
            <div class="window-content">
                <div class="dm-toolbar">
                    <button class="win95-button challenge-button dm-challenge-btn"
                            title="Challenge to a game"
                            data-nick="${escapeHtml(recipient)}">🎮 Challenge ▾</button>
                </div>
                <div class="chat-messages dm-messages"></div>
                <div class="chat-status">
                    <span class="typing-indicator"></span>
                </div>
                <div class="chat-input">
                    <input type="text" placeholder="Type your message..." class="message-input">
                    <button class="win95-button send-button">Send</button>
                </div>
            </div>
        `;
        
        document.querySelector('.win95-container').appendChild(dmWindow);
        makeWindowsDraggable();
        
        // Add event listeners for sending messages
        const messageInput = dmWindow.querySelector('.message-input');
        const sendButton = dmWindow.querySelector('.send-button');
        const toolbar = wireChatToolbar(messageInput);

        const sendDirectMessage = () => {
            const raw = messageInput.value.trim();
            if (raw && socket && socket.readyState === WebSocket.OPEN) {
                const message = toolbar.encodeFor(raw);
                socket.send(JSON.stringify({
                    type: 'direct_message',
                    to: recipient,
                    message: message
                }));
                messageInput.value = '';
            }
        };
        
        sendButton.addEventListener('click', sendDirectMessage);
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                sendDirectMessage();
            } else {
                // Send typing indicator
                const profile = getUserProfile();
                if (profile.typingIndicator && socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        type: 'direct_typing',
                        to: recipient
                    }));
                }
            }
        });

        // Wire the Challenge dropdown in the DM toolbar.
        const challengeBtn = dmWindow.querySelector('.dm-challenge-btn');
        if (challengeBtn) {
            challengeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showChallengeMenu(challengeBtn, recipient);
            });
        }

        // Request message history. Prefer the persistent SQLite store (Phase
        // 1.3) so DM history survives Railway redeploys; fall back to the
        // in-memory WS history if the HTTP request fails.
        fetch(`backend.php?endpoint=get-dm-history&with=${encodeURIComponent(recipient)}`, { credentials: 'same-origin' })
            .then(r => r.json())
            .then(data => {
                if (data && data.success && Array.isArray(data.messages)) {
                    // Convert SQLite shape -> the shape loadDirectMessageHistory expects.
                    const messages = data.messages
                        .filter(m => m.message_type !== 'game_invite' && m.message_type !== 'game_result')
                        .map(m => ({ from: m.sender, to: m.recipient, message: m.message, timestamp: m.timestamp }));
                    loadDirectMessageHistory(recipient, messages);
                } else if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'get_direct_messages', with: recipient }));
                }
            })
            .catch(() => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'get_direct_messages', with: recipient }));
                }
            });
    }
    
    showWindow(windowId);
}

function handleIncomingDirectMessage(data) {
    const { from, message, timestamp, autoReply } = data;

    console.log('Received direct message from:', from, autoReply ? '(auto-reply)' : '');

    // Add message to DM window if it exists, or create new window
    let windowId = `dm-window-${from.replace(/[^a-zA-Z0-9]/g, '')}`;
    let dmWindow = document.getElementById(windowId);
    
    if (!dmWindow) {
        console.log('Creating new DM window for sender:', from);
        showDirectMessageWindow(from);
        dmWindow = document.getElementById(windowId);
    }
    
    if (dmWindow) {
        // Add message to window
        console.log(`Displaying message in window from: ${from}, message: ${message.substring(0, 20)}...`);
        addDirectMessage(from, from, message, new Date(timestamp), false, !!autoReply);

        // Play sound notification (auto-replies use the gotmail chime to
        // make it obvious they're an away-message bounce, not a live reply).
        const profile = getUserProfile();
        if (profile.soundEnabled) {
            playSound(autoReply ? 'gotmail-sound' : 'chat-sound');
        }
    } else {
        console.error('Failed to create or find DM window for:', from);
    }
}

function addDirectMessage(recipient, sender, message, timestamp, isSent, isAutoReply) {
    const sanitizedRecipient = recipient.replace(/[^a-zA-Z0-9]/g, '');
    const windowId = `dm-window-${sanitizedRecipient}`;
    const dmWindow = document.getElementById(windowId);

    console.log(`Adding message to ${windowId}, exists: ${!!dmWindow}`);

    if (!dmWindow) {
        console.error(`DM window not found for ${recipient}, windowId: ${windowId}`);
        return;
    }

    const messagesContainer = dmWindow.querySelector('.dm-messages');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${isSent ? 'sent' : 'received'}${isAutoReply ? ' auto-reply' : ''}`;

    const timeStr = formatMessageTime(timestamp);
    const autoTag = isAutoReply
        ? `<span class="auto-reply-tag" title="Sent automatically because the recipient is away">Auto-Reply</span> `
        : '';

    messageElement.innerHTML = `
        <div class="message-header">
            <span class="message-sender clickable-nick" data-nick="${escapeHtml(sender)}">${escapeHtml(sender)}:</span>
            ${autoTag}
            <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-content">${renderRichMessage(message)}</div>
    `;

    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function loadDirectMessageHistory(recipient, messages) {
    const sanitizedRecipient = recipient.replace(/[^a-zA-Z0-9]/g, '');
    const windowId = `dm-window-${sanitizedRecipient}`;
    const dmWindow = document.getElementById(windowId);
    
    console.log(`Loading message history for ${recipient}, windowId: ${windowId}, exists: ${!!dmWindow}`);
    
    if (!dmWindow) {
        console.error(`DM window not found for history loading: ${recipient}`);
        return;
    }
    
    const messagesContainer = dmWindow.querySelector('.dm-messages');
    messagesContainer.innerHTML = '';
    
    if (messages.length === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'system-message';
        emptyMessage.textContent = 'No previous messages. Start a conversation!';
        messagesContainer.appendChild(emptyMessage);
        return;
    }
    
    messages.forEach(msg => {
        const isSent = msg.from === userInfo.nickname;
        addDirectMessage(
            isSent ? msg.to : msg.from,
            msg.from,
            msg.message,
            new Date(msg.timestamp),
            isSent
        );
    });
}

function updateDirectTypingIndicator(from) {
    const sanitizedFrom = from.replace(/[^a-zA-Z0-9]/g, '');
    const windowId = `dm-window-${sanitizedFrom}`;
    const dmWindow = document.getElementById(windowId);
    
    if (!dmWindow) {
        console.log(`Cannot show typing indicator - no window for ${from}`);
        return;
    }
    
    const typingIndicator = dmWindow.querySelector('.typing-indicator');
    typingIndicator.textContent = `${from} is typing...`;
    
    // Clear typing indicator after 2 seconds
    setTimeout(() => {
        if (typingIndicator.textContent === `${from} is typing...`) {
            typingIndicator.textContent = '';
        }
    }, 2000);
}

// Format timestamp for display
function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    
    const now = new Date();
    const date = new Date(timestamp);
    const secondsAgo = Math.floor((now - date) / 1000);
    
    if (secondsAgo < 60) {
        return 'Just now';
    } else if (secondsAgo < 3600) {
        const minutes = Math.floor(secondsAgo / 60);
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
    } else if (secondsAgo < 86400) {
        const hours = Math.floor(secondsAgo / 3600);
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    } else {
        const days = Math.floor(secondsAgo / 86400);
        return `${days} ${days === 1 ? 'day' : 'days'} ago`;
    }
}

// Format time for chat messages
function formatMessageTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    
    return `${displayHours}:${minutes} ${ampm}`;
}

// Update the clock in the taskbar
function updateTaskbarClock() {
    const now = new Date();
    let hours = now.getHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const minutes = now.getMinutes().toString().padStart(2, '0');
    document.getElementById('taskbar-time').textContent = `${hours}:${minutes} ${ampm}`;
}

// Initialize desktop interface
function initializeDesktop() {
    // Make windows draggable
    makeWindowsDraggable();

    // Welcome chime — plays once when the desktop renders after sign-in.
    // force=true so it plays through even if sound notifications are off;
    // this is the AOL '95 "Welcome!" moment, not a notification.
    // Browsers may block autoplay until the user has interacted with the
    // document; that's fine — playSound() swallows the rejection so a
    // returning user who skipped the splash still gets a desktop.
    setTimeout(() => { playSound('startup-sound', { force: true }); }, 250);

    // Hydrate the buddy list from the SQLite backend. Falls back to the
    // localStorage snapshot if the network is unreachable.
    loadBuddiesFromBackend();

    // Hydrate the profile from the server so changes in another browser
    // show up here. localStorage is the synchronous read cache; this is
    // the cross-device source of truth (Phase 1.4).
    refreshProfileFromServer();

    // Click on any nickname in the UI to open that buddy's profile.
    ensureClickableNickDelegation();

    // Mailbox polling — checks for unread DMs every 30s, badges the
    // taskbar icon, pops "you've got mail" on the first new message.
    startMailPolling();

    // Phase 4.8 — Konami code listener (↑↑↓↓←→←→BA → Snake).
    ensureKonamiListener();

    // Phase 4.6 — right-click desktop for wallpaper picker.
    ensureWallpaperPicker();
    applyWallpaper(getUserProfile().wallpaper || 'teal');

    // The WS server pushes an `active_users` roster on every identify and
    // every ACTIVE_USERS_INTERVAL_MS (15s). It's the authoritative source
    // for "who's currently connected". The previous design ALSO polled
    // backend.php?endpoint=active-users every 15s, which queried SQL for
    // "users active in the last 5 min" — but that SQL has no view of
    // currently-connected sockets, so it disagreed with the WS roster and
    // the buddy list flickered users on/off. WS-only fixes that.
    //
    // Cold-start fallback: if WS hasn't delivered a roster within 2s
    // (network slow, Railway cold-starting, etc.), hit the HTTP endpoint
    // once so the desktop counter isn't stuck at 0.
    setTimeout(() => {
        if (rosterSnapshot === null) fetchActiveUsers();
    }, 2000);
    
    // Initialize chatrooms icon click handler
    const chatroomsIcon = document.getElementById('chatrooms-icon');
    if (chatroomsIcon) {
        chatroomsIcon.addEventListener('click', () => {
            const chatroomsWindow = document.getElementById('chatrooms-window');
            if (chatroomsWindow) {
                chatroomsWindow.style.display = 'flex';
                showWindow('chatrooms-window');
                loadChatrooms();
            }
        });
    }
    
    // Initialize create room functionality
    const createRoomBtn = document.getElementById('create-room-btn');
    const createRoomDialog = document.getElementById('create-room-dialog');
    const createRoomForm = document.getElementById('create-room-form');
    const cancelCreateRoom = document.getElementById('cancel-create-room');
    
    if (createRoomBtn) {
        createRoomBtn.addEventListener('click', () => {
            createRoomDialog.style.display = 'flex';
            showWindow('create-room-dialog');
        });
    }
    
    if (cancelCreateRoom) {
        cancelCreateRoom.addEventListener('click', () => {
            createRoomDialog.style.display = 'none';
            document.getElementById('room-name').value = '';
        });
    }
    
    if (createRoomForm) {
        createRoomForm.addEventListener('submit', (e) => {
            e.preventDefault();
            createNewRoom();
        });
    }
    
    // Initialize user profile icon click handler
    const userProfileIcon = document.getElementById('user-profile-icon');
    if (userProfileIcon) {
        userProfileIcon.addEventListener('click', () => {
            showProfileWindow();
        });
    }
    
    // Initialize active users icon click handler
    const activeUsersIcon = document.getElementById('active-users-icon');
    if (activeUsersIcon) {
        activeUsersIcon.addEventListener('click', () => {
            showActiveNowWindow();
        });
    }
    
    // Initialize logout icon click handler
    const logoutIcon = document.getElementById('logout-icon');
    if (logoutIcon) {
        logoutIcon.addEventListener('click', () => {
            signOff();
        });
    }

    // Connect to WebSocket for real-time updates
    connectToWebSocket();
}

// Play the AIM '95 sign-off chime, then navigate to logout. force=true so
// the sound plays even if the user disabled sound notifications — it's a
// short, intentional UX moment, not a passive notification.
function signOff() {
    playSound('goodbye-sound', { force: true });
    setTimeout(() => { window.location.href = '?logout=1'; }, 700);
}

function showWindow(windowId) {
    const window = document.getElementById(windowId);
    if (!window) {
        console.error(`Window not found: ${windowId}`);
        return;
    }

    // Show the requested window
    window.style.display = 'flex';
    bringToFront(window);

    // Add to taskbar if not already there
    let taskbarItem = document.querySelector(`.taskbar-item[data-window="${windowId}"]`);
    if (!taskbarItem) {
        taskbarItem = document.createElement('div');
        taskbarItem.className = 'taskbar-item active';
        taskbarItem.setAttribute('data-window', windowId);
        taskbarItem.textContent = window.querySelector('.window-title').textContent;

        // Insert before the taskbar-time element
        const taskbarTime = document.querySelector('.taskbar-time');
        if (taskbarTime) {
            taskbarTime.parentNode.insertBefore(taskbarItem, taskbarTime);
        }

        // Add click handler to taskbar item
        taskbarItem.addEventListener('click', () => {
            if (window.style.display === 'none') {
                window.style.display = 'flex';
                bringToFront(window);
                taskbarItem.classList.add('active');
            } else {
                window.style.display = 'none';
                taskbarItem.classList.remove('active');
            }
        });
    }

    // Update taskbar item state
    document.querySelectorAll('.taskbar-item').forEach(item => {
        item.classList.remove('active');
    });
    taskbarItem.classList.add('active');
}

// Load chatrooms from backend
function loadChatrooms() {
    const roomList = document.getElementById('room-list');
    roomList.innerHTML = '<div class="loading">Loading chatrooms...</div>';
    
    fetch('backend.php?endpoint=rooms')
        .then(response => response.json())
        .then(data => {
            if (data.success && data.rooms.length > 0) {
                roomList.innerHTML = '';
                data.rooms.forEach(room => {
                    const roomItem = document.createElement('div');
                    roomItem.classList.add('room-item');
                    roomItem.dataset.roomId = room.id;
                    
                    const roomDate = new Date(room.created_at);
                    const formattedDate = `${roomDate.toLocaleDateString()} ${roomDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
                    
                    const adminControls = (typeof userInfo !== 'undefined' && userInfo.isAdmin)
                        ? `<button class="room-delete-btn" title="Delete this chatroom" data-room-id="${room.id}" data-room-name="${room.name.replace(/"/g, '&quot;')}">×</button>`
                        : '';

                    roomItem.innerHTML = `
                        <img src="images/chatrooms.png" class="room-icon" alt="">
                        <span class="room-name">${room.name}</span>
                        <span class="room-info">Created: ${formattedDate}</span>
                        ${adminControls}
                    `;

                    roomItem.addEventListener('click', (e) => {
                        if (e.target.classList.contains('room-delete-btn')) {
                            e.stopPropagation();
                            deleteChatroom(room.id, room.name);
                            return;
                        }
                        openChatRoom(room);
                    });
                    roomList.appendChild(roomItem);
                });
            } else {
                roomList.innerHTML = '<div class="loading">No chatrooms available. Create a new one!</div>';
            }
        })
        .catch(error => {
            console.error('Error loading chatrooms:', error);
            roomList.innerHTML = '<div class="loading">Error loading chatrooms. Please try again.</div>';
            
            // Play error sound
            playSound('error-sound');
        });
}

// Create a new chatroom
function createNewRoom() {
    const roomName = document.getElementById('room-name').value.trim();
    if (!roomName) {
        console.error('Room name is empty');
        alert('Please enter a room name');
        return;
    }
    
    console.log('Creating new room:', roomName);
    
    window.apiPost('create-room', { name: roomName })
    .then(response => {
        console.log('Create room response status:', response.status);
        console.log('Create room response headers:', Object.fromEntries(response.headers.entries()));
        return response.text().then(text => {
            console.log('Create room raw response:', text);
            try {
                return JSON.parse(text);
            } catch (e) {
                console.error('Invalid JSON in response:', text);
                throw new Error('Invalid server response');
            }
        });
    })
    .then(data => {
        console.log('Create room response data:', data);
        if (data.success) {
            document.getElementById('create-room-dialog').style.display = 'none';
            document.getElementById('room-name').value = '';
            loadChatrooms();
            openChatRoom(data.room);
        } else {
            console.error('Failed to create room:', data.error);
            alert(data.error || 'Could not create room');
            
            // Play error sound
            playSound('error-sound');
        }
    })
    .catch(error => {
        console.error('Error creating room:', error);
        alert('Error creating room. Please try again.');
        
        // Play error sound
        playSound('error-sound');
    });
}

// Admin-only: delete a chatroom and all of its messages.
function deleteChatroom(roomId, roomName) {
    if (typeof userInfo === 'undefined' || !userInfo.isAdmin) return;
    if (!confirm(`Delete chatroom "${roomName}"?\nAll messages in this room will be permanently removed.`)) {
        return;
    }
    window.apiPost('delete-room', { room_id: roomId })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                const openWin = document.getElementById(`chat-window-${roomId}`);
                if (openWin) openWin.remove();
                loadChatrooms();
            } else {
                alert(data.error || 'Could not delete room');
                playSound('error-sound');
            }
        })
        .catch(err => {
            console.error('Error deleting room:', err);
            alert('Error deleting room. Please try again.');
            playSound('error-sound');
        });
}

// Open a chat room
function openChatRoom(room) {
    let chatWindow = document.getElementById(`chat-window-${room.id}`);
    
    // If chat window doesn't exist, create it
    if (!chatWindow) {
        const template = document.getElementById('chat-window-template');
        chatWindow = template.cloneNode(true);
        chatWindow.id = `chat-window-${room.id}`;
        chatWindow.dataset.roomId = room.id;
        chatWindow.style.display = 'flex';
        
        // Set window position slightly offset from previous windows
        const offset = document.querySelectorAll('.chat-window').length * 20;
        chatWindow.style.top = `${100 + offset}px`;
        chatWindow.style.left = `${100 + offset}px`;
        
        // Set room title
        chatWindow.querySelector('.window-title').textContent = `Chat: ${room.name} (${userInfo.nickname})`;
        
        // Add event listener for sending messages
        const messageInput = chatWindow.querySelector('.message-input');
        const sendButton = chatWindow.querySelector('.send-button');
        const toolbar = wireChatToolbar(messageInput);

        const sendMessage = () => {
            const raw = messageInput.value.trim();
            if (raw) {
                // Apply current formatting (Phase 3.4) — toolbar.encodeFor
                // wraps with JSON if any style is active, else passes plain.
                const message = toolbar.encodeFor(raw);
                // Send via WebSocket for real-time updates
                socket.send(JSON.stringify({
                    type: 'message',
                    roomId: room.id,
                    message: message,
                    nickname: userInfo.nickname
                }));

                // Also save directly to database for persistence
                saveChatMessageToDatabase(room.id, message);

                // Clear input
                messageInput.value = '';
            }
        };
        
        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            } else {
                // Send typing indicator
                // Check profile settings before sending typing indicator
                const profile = getUserProfile();
                if (profile.typingIndicator) {
                    socket.send(JSON.stringify({
                        type: 'typing',
                        roomId: room.id,
                        nickname: userInfo.nickname
                    }));
                }
            }
        });
        
        // Append new window to container
        document.querySelector('.win95-container').appendChild(chatWindow);
        
        // Make the new window draggable
        makeWindowsDraggable();
        
        // Load previous messages
        loadChatMessages(room.id);
        
        // Join the room
        socket.send(JSON.stringify({
            type: 'join',
            roomId: room.id,
            nickname: userInfo.nickname
        }));
        
        // Update active rooms count
        updateActiveRoomsCount();
    } else {
        chatWindow.style.display = 'flex';
    }
    
    showWindow(chatWindow.id);
}

// Load previous chat messages
function loadChatMessages(roomId, oldestTimestamp = null) {
    const chatWindow = document.getElementById(`chat-window-${roomId}`);
    const chatMessages = chatWindow.querySelector('.chat-messages');
    
    // Only show loading indicator for first load
    if (!oldestTimestamp) {
        chatMessages.innerHTML = '<div class="loading">Loading messages...</div>';
    }
    
    // Prepare URL with optional timestamp for pagination
    let url = `backend.php?endpoint=get-messages&room_id=${roomId}`;
    if (oldestTimestamp) {
        url += `&before=${encodeURIComponent(oldestTimestamp)}`;
    }
    
    fetch(url)
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                if (!oldestTimestamp) {
                    // First load - clear the container
                    chatMessages.innerHTML = '';
                } else {
                    // Loading more history - remove loading indicator if exists
                    const loadingIndicator = chatMessages.querySelector('.load-more');
                    if (loadingIndicator) {
                        loadingIndicator.remove();
                    }
                }
                
                if (data.messages.length === 0 && !oldestTimestamp) {
                    // No messages at all
                    addSystemMessage(roomId, 'No messages yet. Be the first to say hello!');
                } else if (data.messages.length > 0) {
                    // Create a document fragment to minimize DOM operations
                    const fragment = document.createDocumentFragment();
                    
                    // If loading more messages, prepend them
                    if (oldestTimestamp) {
                        // Save current scroll position
                        const scrollBottom = chatMessages.scrollHeight - chatMessages.scrollTop;
                        
                        // Add messages to fragment
                        data.messages.forEach(msg => {
                            const messageElement = createChatMessage(
                                msg.user_nickname, 
                                msg.message, 
                                new Date(msg.timestamp),
                                true // Mark as historical message
                            );
                            fragment.appendChild(messageElement);
                        });
                        
                        // Add load more button if there are more messages
                        if (data.has_more) {
                            const loadMoreBtn = document.createElement('div');
                            loadMoreBtn.className = 'load-more';
                            loadMoreBtn.innerHTML = '<button class="win95-button">Load More Messages</button>';
                            loadMoreBtn.querySelector('button').addEventListener('click', () => {
                                loadMoreBtn.innerHTML = '<div class="loading">Loading...</div>';
                                loadChatMessages(roomId, data.oldest_timestamp);
                            });
                            fragment.insertBefore(loadMoreBtn, fragment.firstChild);
                        }
                        
                        // Insert at the beginning
                        if (chatMessages.firstChild) {
                            chatMessages.insertBefore(fragment, chatMessages.firstChild);
                        } else {
                            chatMessages.appendChild(fragment);
                        }
                        
                        // Restore scroll position
                        chatMessages.scrollTop = chatMessages.scrollHeight - scrollBottom;
                    } else {
                        // Add messages to fragment
                        data.messages.forEach(msg => {
                            const messageElement = createChatMessage(
                                msg.user_nickname, 
                                msg.message, 
                                new Date(msg.timestamp),
                                true // Mark as historical message
                            );
                            fragment.appendChild(messageElement);
                        });
                        
                        // Add load more button if there are more messages
                        if (data.has_more) {
                            const loadMoreBtn = document.createElement('div');
                            loadMoreBtn.className = 'load-more';
                            loadMoreBtn.innerHTML = '<button class="win95-button">Load More Messages</button>';
                            loadMoreBtn.querySelector('button').addEventListener('click', () => {
                                loadMoreBtn.innerHTML = '<div class="loading">Loading...</div>';
                                loadChatMessages(roomId, data.oldest_timestamp);
                            });
                            fragment.insertBefore(loadMoreBtn, fragment.firstChild);
                        }
                        
                        // Append to the end
                        chatMessages.appendChild(fragment);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                }
            } else {
                if (!oldestTimestamp) {
                    chatMessages.innerHTML = '<div class="system-message">Error loading messages. Please try again.</div>';
                }
                
                // Play error sound
                playSound('error-sound');
            }
        })
        .catch(error => {
            console.error('Error loading messages:', error);
            if (!oldestTimestamp) {
                chatMessages.innerHTML = '<div class="system-message">Error loading messages. Please try again.</div>';
            }
            
            // Play error sound
            playSound('error-sound');
        });
}

// Helper function to create a chat message element
function createChatMessage(nickname, message, timestamp, isHistory = false) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message');
    if (isHistory) {
        messageElement.classList.add('history');
    }
    
    const timeStr = formatMessageTime(timestamp);
    
    messageElement.innerHTML = `
        <div class="message-header">
            <span class="message-sender clickable-nick" data-nick="${escapeHtml(nickname)}">${escapeHtml(nickname)}:</span>
            <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-content">${renderRichMessage(message)}</div>
    `;

    return messageElement;
}

// Add chat message to window
function addChatMessage(roomId, nickname, message, timestamp) {
    const chatWindow = document.getElementById(`chat-window-${roomId}`);
    if (!chatWindow) return;
    
    const chatMessages = chatWindow.querySelector('.chat-messages');
    const time = timestamp ? timestamp : new Date();
    
    // Use the helper function to create the message element
    const messageElement = createChatMessage(nickname, message, time, !!timestamp);
    
    // Add to DOM
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    // Also save to database through our WebSocket
    if (!timestamp && socket && socket.readyState === WebSocket.OPEN) {
        // Message will be automatically saved if it came from the WebSocket
        // This is for messages sent directly from this client
        if (nickname === userInfo.nickname) {
            saveChatMessageToDatabase(roomId, message);
        }
    }
    
    // Play chat sound for new messages (only for messages not from history)
    if (!timestamp) {
        // Check profile settings before playing sound
        const profile = getUserProfile();
        if (profile.soundEnabled) {
            playSound('chat-sound');
        }
    }
}

// Save message to database
function saveChatMessageToDatabase(roomId, message) {
    window.apiPost('save-message', { room_id: roomId, message: message })
    .then(response => response.json())
    .catch(error => {
        console.error('Error saving message to database:', error);
    });
}

// Add system message to chat
function addSystemMessage(roomId, message) {
    const chatWindow = document.getElementById(`chat-window-${roomId}`);
    if (!chatWindow) return;
    
    const chatMessages = chatWindow.querySelector('.chat-messages');
    const messageElement = document.createElement('div');
    messageElement.classList.add('system-message');
    messageElement.textContent = message;
    
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Update online users count
function updateOnlineUsers(roomId, count) {
    const chatWindow = document.getElementById(`chat-window-${roomId}`);
    if (!chatWindow) return;
    
    const onlineUsers = chatWindow.querySelector('.online-users');
    onlineUsers.textContent = `Users online: ${count}`;
}

// Update typing indicator
function updateTypingIndicator(roomId, nickname, isTyping) {
    const chatWindow = document.getElementById(`chat-window-${roomId}`);
    if (!chatWindow) return;
    
    const typingIndicator = chatWindow.querySelector('.typing-indicator');
    
    if (isTyping && nickname !== userInfo.nickname) {
        typingIndicator.textContent = `${nickname} is typing...`;
        
        // Clear typing indicator after 2 seconds
        setTimeout(() => {
            if (typingIndicator.textContent === `${nickname} is typing...`) {
                typingIndicator.textContent = '';
            }
        }, 2000);
    } else if (!isTyping && typingIndicator.textContent === `${nickname} is typing...`) {
        typingIndicator.textContent = '';
    }
}

// WebSocket connection
let socket = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
// Last roster we got from the server; used to diff for buddyin/buddyout
// chimes. null means "no roster yet" — first update is treated as baseline.
let rosterSnapshot = null;

function connectToWebSocket() {
    // Check if WebSocket is supported
    if (!window.WebSocket) {
        alert('Your browser does not support WebSockets. Some features may not work.');
        return;
    }
    
    // Create WebSocket connection.
    // WS_HOST is set in index.php (read from PHP so it can be swapped without touching JS).
    // Always use wss:// when the page is https, otherwise the browser will block the connection.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.WS_HOST;
    if (!host) {
        console.error('WS_HOST is not set — chat features are unavailable. Check index.php $WS_HOST.');
        return;
    }
    socket = new WebSocket(`${protocol}//${host}`);
    
    socket.onopen = function() {
        console.log('WebSocket connection established');
        reconnectAttempts = 0;
        
        // Get user profile
        const profile = getUserProfile();
        
        // Identify user to server (token verified server-side via WS_SECRET).
        socket.send(JSON.stringify({
            type: 'identify',
            token: window.WS_TOKEN || '',
            nickname: userInfo.nickname,
            displayName: profile.displayName,
            status: profile.status,
            avatarColor: profile.avatarColor,
            profile: profile
        }));
    };
    
    socket.onmessage = function(event) {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
            case 'message':
                // Add message to UI
                addChatMessage(data.roomId, data.nickname, data.message);
                
                // Save to database - but only for messages from other users
                // Our own messages are saved by the sender
                if (data.nickname !== userInfo.nickname) {
                    saveChatMessageToDatabase(data.roomId, data.message);
                }
                break;
                
            case 'join':
                addSystemMessage(data.roomId, `${data.nickname} has joined the room`);
                if (data.userCount) updateOnlineUsers(data.roomId, data.userCount);
                break;
                
            case 'leave':
                addSystemMessage(data.roomId, `${data.nickname} has left the room`);
                if (data.userCount) updateOnlineUsers(data.roomId, data.userCount);
                break;
                
            case 'typing':
                updateTypingIndicator(data.roomId, data.nickname, true);
                break;
                
            case 'active_users':
                // Diff roster against the previous snapshot for buddyin/out
                // chimes. Skip the very first update so the user doesn't get
                // a barrage of pings for everyone already online at connect.
                {
                    const current = new Set((data.users || []).map(u => u.nickname));
                    if (rosterSnapshot !== null) {
                        const buddySet = new Set(getBuddies());
                        for (const nick of current) {
                            if (!rosterSnapshot.has(nick) && nick !== userInfo.nickname) {
                                playSound('buddyin-sound');
                                // Phase 3.6: only pop the toast for users on
                                // your buddy list — randoms still chime but
                                // don't generate UI noise.
                                if (buddySet.has(nick)) {
                                    showBuddyToast(nick, 'signed on');
                                }
                                break; // one chime per update is plenty
                            }
                        }
                        for (const nick of rosterSnapshot) {
                            if (!current.has(nick) && nick !== userInfo.nickname) {
                                playSound('buddyout-sound');
                                if (buddySet.has(nick)) {
                                    showBuddyToast(nick, 'signed off');
                                }
                                break;
                            }
                        }
                    }
                    rosterSnapshot = current;
                }

                updateActiveUsersList(data.users);
                // Update the counter in the desktop icon
                const userCount = document.querySelector('#active-users-icon .user-count');
                if (userCount) {
                    userCount.textContent = data.users.length;
                }
                break;
            
            case 'direct_message':
                handleIncomingDirectMessage(data);
                break;
                
            case 'direct_message_sent':
                // Add sent message to direct message window
                addDirectMessage(data.to, userInfo.nickname, data.message, new Date(data.timestamp), true);
                break;
                
            case 'direct_message_history':
                loadDirectMessageHistory(data.with, data.messages);
                break;
                
            case 'direct_typing':
                updateDirectTypingIndicator(data.from);
                break;
                
            case 'message_saved':
                // Confirmation that a message was saved to database
                console.log('Message saved to database:', data.messageId);
                break;
                
            case 'error':
                console.error('WebSocket error:', data.message);
                addSystemMessage(data.roomId, `Error: ${data.message}`);

                // Play error sound
                const profile = getUserProfile();
                if (profile.soundEnabled) {
                    playSound('error-sound');
                }
                break;

            // -------- Games (Phase 1 scaffolding) --------
            case 'game_invite':       handleGameInvite(data);   break;
            case 'game_accept':       handleGameAccept(data);   break;
            case 'game_decline':      handleGameDecline(data);  break;
            case 'game_state':        handleGameState(data);    break;
            case 'game_over':         handleGameOver(data);     break;
            case 'game_chat':         handleGameChat(data);     break;
            case 'game_error':        handleGameError(data);    break;
            case 'active_games_list': handleActiveGamesList(data); break;
        }
    };
    
    socket.onclose = function(event) {
        console.log('WebSocket connection closed', event.code, event.reason);
        // Drop the roster snapshot so reconnects don't false-fire buddyout.
        rosterSnapshot = null;

        // 1008 = policy violation. Server uses this for bad/expired tokens.
        // Silently reconnecting would just loop, so tell the user instead.
        if (event.code === 1008) {
            playSound('error-sound');
            alert('Your session expired or the chat server rejected the token.\nPlease log out and back in.');
            return;
        }

        // If it wasn't a clean close, attempt to reconnect
        if (!event.wasClean && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const delay = Math.min(1000 * reconnectAttempts, 5000);
            setTimeout(connectToWebSocket, delay);
            console.log(`Reconnecting (attempt ${reconnectAttempts})...`);
        } else if (reconnectAttempts >= maxReconnectAttempts) {
            alert('Could not reconnect to the chat server. Please refresh the page.');
        }
    };
    
    socket.onerror = function(error) {
        console.error('WebSocket error:', error);
    };
    
    // Fallback for sending messages if WebSocket fails
    window.sendMessageFallback = function(roomId, message) {
        window.apiPost('save-message', { room_id: roomId, message: message })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                loadChatMessages(roomId);
            } else {
                alert(data.error || 'Failed to send message');
                
                // Play error sound
                playSound('error-sound');
            }
        })
        .catch(error => {
            console.error('Error sending message:', error);
            alert('Error sending message. Please try again.');
            
            // Play error sound
            playSound('error-sound');
        });
    };
}

// Helper function to escape HTML
function escapeHtml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ============================================================================
// Rich message rendering (Phase 3.3 + 3.4) — smileys + safe inline formatting
// ============================================================================
//
// Wire format: a chat/DM/game-chat message is either:
//   (a) plain string                       (backward compat — pre-Phase 3)
//   (b) JSON string `{"text":"…","style":{"bold":true,"color":"#ff0000",…}}`
//
// Detection is "does it start with `{` and parse cleanly as an object with a
// string `text` field?". Plain strings that happen to start with `{` (rare)
// still render correctly because JSON.parse throws on malformed input.
//
// Rendering pipeline:
//   1. parseRichMessage(raw) -> { text, style? }
//   2. Walk `text`, escaping ordinary chars and replacing smiley patterns
//      with safe inline emoji spans. (Smileys are substituted BEFORE the
//      surrounding HTML escape so the <span> isn't double-escaped.)
//   3. Wrap in <span style="…"> whitelisted to bold/italic/underline/color/font.
//
// Security: the only HTML the renderer ever emits is escapeHtml output plus
// a fixed set of <span> tags with vetted style attributes — no innerHTML
// passthrough.

const AIM_SMILEYS = {
    '<3':   '❤️',
    ':D':   '😄',
    ':)':   '😀',
    ':-)':  '😀',
    '=)':   '😊',
    ':(':   '😞',
    ':-(':  '😞',
    ';)':   '😉',
    ';-)':  '😉',
    ':P':   '😛',
    ':p':   '😛',
    ':O':   '😮',
    ':o':   '😮',
    ':|':   '😐',
    ':/':   '😕',
    ':\\':  '😕',
    ':*':   '😘',
    'B)':   '😎',
    ':3':   '😺',
    'xD':   '😆',
    'XD':   '😆',
    ":')":  '😂',
    ":'(":  '😢',
    '>:(':  '😠',
    '(y)':  '👍',
    '(n)':  '👎',
    'lol':  '😂',
    'omg':  '😱',
    'zzz':  '💤',
};

// Sort by descending length so e.g. ":-)" matches before ":)" doesn't grab
// part of ";-)". Patterns are escaped for safe regex use.
const AIM_SMILEY_PATTERN = new RegExp(
    Object.keys(AIM_SMILEYS)
        .sort((a, b) => b.length - a.length)
        .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
    'g'
);

// Picker grid order — what users see in the smiley popover. Roughly the
// classic AIM "must-have" set in expected rows.
const AIM_SMILEY_PICKER = [
    ':)', ':(', ':D', ':P', ';)', ':O',
    '<3', 'B)', ':*', ':|', ':/', 'xD',
    "(y)", "(n)", ":'(", '>:(', ':3', 'zzz',
];

// Whitelist for inline `font-family`. Mirrors the chunky 90s feel — Comic
// Sans for the Letterman set, Impact for caps-lock people, etc.
const AIM_ALLOWED_FONTS = [
    'MS Sans Serif', 'Courier New', 'Times New Roman', 'Comic Sans MS', 'Impact',
];

// Whitelist for inline `color`. <input type="color"> emits 7-char hex, which
// matches /^#[0-9a-f]{6}$/ — anything else is rejected to keep `style` clean.

function parseRichMessage(raw) {
    if (typeof raw !== 'string' || raw === '') return { text: '', style: null };
    if (raw.charCodeAt(0) !== 123 /* '{' */) return { text: raw, style: null };
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && typeof obj.text === 'string') {
            return { text: obj.text, style: obj.style || null };
        }
    } catch (_) { /* not JSON, fall through */ }
    return { text: raw, style: null };
}

function styleToCss(style) {
    if (!style || typeof style !== 'object') return '';
    const out = [];
    if (style.bold)      out.push('font-weight: bold');
    if (style.italic)    out.push('font-style: italic');
    if (style.underline) out.push('text-decoration: underline');
    if (typeof style.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color)) {
        out.push(`color: ${style.color}`);
    }
    if (typeof style.font === 'string' && AIM_ALLOWED_FONTS.includes(style.font)) {
        out.push(`font-family: "${style.font}", "MS Sans Serif", sans-serif`);
    }
    return out.join('; ');
}

// Renders ONE message string into safe HTML (smileys + escapes + optional
// style wrapper). Everything that used to call escapeHtml(message) for chat
// rendering should call this instead.
function renderRichMessage(raw) {
    const { text, style } = parseRichMessage(raw);

    // Walk the text, escaping non-smiley chunks and substituting smileys.
    let html = '';
    let last = 0;
    AIM_SMILEY_PATTERN.lastIndex = 0;
    let m;
    while ((m = AIM_SMILEY_PATTERN.exec(text)) !== null) {
        if (m.index > last) html += escapeHtml(text.substring(last, m.index));
        const code = m[0];
        html += `<span class="smiley" title="${escapeHtml(code)}">${AIM_SMILEYS[code]}</span>`;
        last = m.index + code.length;
    }
    if (last < text.length) html += escapeHtml(text.substring(last));

    const css = styleToCss(style);
    if (css) return `<span style="${css}">${html}</span>`;
    return html;
}

// Encode a plain text + style into the wire format. If style has no
// active flags, emits plain text for backward-compat-friendly storage.
function encodeRichMessage(text, style) {
    if (!style) return text;
    const hasAny = style.bold || style.italic || style.underline
                || (style.color && style.color !== '#000000')
                || (style.font && style.font !== 'MS Sans Serif');
    if (!hasAny) return text;
    // Strip empty / default fields so the JSON stays small. Each field has
    // its own "is this the default?" rule — bool flags drop on false,
    // color drops on plain black, font drops on the system default.
    const clean = {};
    if (style.bold)      clean.bold      = true;
    if (style.italic)    clean.italic    = true;
    if (style.underline) clean.underline = true;
    if (style.color && style.color !== '#000000')      clean.color = style.color;
    if (style.font  && style.font  !== 'MS Sans Serif') clean.font  = style.font;
    return JSON.stringify({ text, style: clean });
}

// Wires a smiley-picker button + formatting toolbar to a chat input. Returns
// an `encodeFor(text)` callback to be used by the caller's send handler.
//
// The toolbar is inserted before the chat-input row. State (bold/italic/
// color/font) lives in closure so each window has its own independent
// toggles — toggling bold in one DM doesn't bold messages in another room.
function wireChatToolbar(input) {
    const inputRow = input.closest('.chat-input');
    if (!inputRow) return { encodeFor: t => t };
    // Idempotent: if we already wired a toolbar to this row, reuse it.
    if (inputRow.previousElementSibling && inputRow.previousElementSibling.classList.contains('chat-toolbar')) {
        return { encodeFor: t => t }; // toolbar exists; assume already wired
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'chat-toolbar';
    toolbar.innerHTML = `
        <button type="button" class="format-btn smiley-trigger" title="Smileys">😀</button>
        <button type="button" class="format-btn format-bold" title="Bold"><b>B</b></button>
        <button type="button" class="format-btn format-italic" title="Italic"><i>I</i></button>
        <button type="button" class="format-btn format-underline" title="Underline"><u>U</u></button>
        <input type="color" class="format-color" title="Text color" value="#000000">
        <select class="format-font win95-input" title="Font">
            ${AIM_ALLOWED_FONTS.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('')}
        </select>
    `;
    inputRow.parentNode.insertBefore(toolbar, inputRow);

    const state = { bold: false, italic: false, underline: false, color: '#000000', font: 'MS Sans Serif' };

    const boldBtn   = toolbar.querySelector('.format-bold');
    const italicBtn = toolbar.querySelector('.format-italic');
    const underBtn  = toolbar.querySelector('.format-underline');
    const colorEl   = toolbar.querySelector('.format-color');
    const fontEl    = toolbar.querySelector('.format-font');
    const smileyBtn = toolbar.querySelector('.smiley-trigger');

    const toggle = (btn, key) => {
        state[key] = !state[key];
        btn.classList.toggle('active', state[key]);
    };
    boldBtn.addEventListener('click',   () => toggle(boldBtn, 'bold'));
    italicBtn.addEventListener('click', () => toggle(italicBtn, 'italic'));
    underBtn.addEventListener('click',  () => toggle(underBtn, 'underline'));
    colorEl.addEventListener('input',   () => { state.color = colorEl.value; });
    fontEl.addEventListener('change',   () => { state.font = fontEl.value; });

    smileyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showSmileyPicker(smileyBtn, (code) => {
            // Insert at cursor position.
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? input.value.length;
            input.value = input.value.substring(0, start) + code + input.value.substring(end);
            const newPos = start + code.length;
            input.setSelectionRange(newPos, newPos);
            input.focus();
        });
    });

    return {
        encodeFor: (text) => {
            // Phase 4.8 — slash command sugar. /me <action> renders italic,
            // attributed third-person. /roll is handled server-side so it
            // passes through here unchanged.
            const meMatch = /^\/me\s+(.+)$/.exec(text);
            if (meMatch) {
                return encodeRichMessage(`* ${userInfo.nickname} ${meMatch[1]}`,
                                         { italic: true, color: '#800080' });
            }
            return encodeRichMessage(text, state);
        },
    };
}

// Anchored Win95 popover of smiley codes. Clicking one calls onPick(code).
function showSmileyPicker(anchorEl, onPick) {
    document.querySelectorAll('.smiley-picker').forEach(el => el.remove());

    const picker = document.createElement('div');
    picker.className = 'smiley-picker';
    picker.innerHTML = AIM_SMILEY_PICKER.map(code => `
        <button type="button" class="smiley-picker-item" data-code="${escapeHtml(code)}"
                title="${escapeHtml(code)}">${AIM_SMILEYS[code]}</button>
    `).join('');
    document.body.appendChild(picker);

    const rect = anchorEl.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = `${rect.left}px`;
    picker.style.top = `${rect.bottom + 2}px`;
    picker.style.zIndex = 99999;

    picker.querySelectorAll('.smiley-picker-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = item.getAttribute('data-code');
            picker.remove();
            onPick(code);
        });
    });

    setTimeout(() => {
        const handler = (e) => {
            if (!picker.contains(e.target) && e.target !== anchorEl) {
                picker.remove();
                document.removeEventListener('click', handler, true);
            }
        };
        document.addEventListener('click', handler, true);
    }, 0);
}

function bringToFront(window) {
    // Get all windows
    const windows = document.querySelectorAll('.window');
    let maxZIndex = 0;

    // Find the highest z-index
    windows.forEach(w => {
        const zIndex = parseInt(getComputedStyle(w).zIndex) || 0;
        maxZIndex = Math.max(maxZIndex, zIndex);
    });

    // Set the clicked window's z-index to be on top
    window.style.zIndex = maxZIndex + 1;
}

function makeWindowsDraggable() {
    const windows = document.querySelectorAll('.window');
    
    windows.forEach(window => {
        const header = window.querySelector('.window-header');
        if (!header) return;
        
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;

        // Store original dimensions for resizable windows (desktop view)
        if (window.offsetWidth > 0 && window.offsetHeight > 0) {
            window.dataset.originalWidth = window.style.width || `${window.offsetWidth}px`;
            window.dataset.originalHeight = window.style.height || `${window.offsetHeight}px`;
        }

        // Click-to-focus: any mousedown inside this window raises it to the
        // top. Idempotent re-attach guard so makeWindowsDraggable() can be
        // called more than once without stacking duplicate listeners.
        if (!window.dataset.focusBound) {
            window.addEventListener('mousedown', () => bringToFront(window), true);
            window.addEventListener('touchstart', () => bringToFront(window), { capture: true, passive: true });
            window.dataset.focusBound = '1';
        }

        header.addEventListener('mousedown', startDragging);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDragging);
        
        // Double-click header to reset window size (for desktop)
        header.addEventListener('dblclick', (e) => {
            // Don't trigger if clicking on window controls
            if (e.target.classList.contains('control-button')) return;
            
            // Only for desktop view and resizable windows
            if (window.innerWidth < 1025 || window.classList.contains('login-window') || window.classList.contains('dialog')) return;
            
            if (window.classList.contains('maximized')) {
                // Restore window to previous size
                window.style.width = window.dataset.prevWidth || window.dataset.originalWidth;
                window.style.height = window.dataset.prevHeight || window.dataset.originalHeight;
                window.style.top = window.dataset.prevTop || '100px';
                window.style.left = window.dataset.prevLeft || '100px';
                window.classList.remove('maximized');
            } else {
                // Store current size and position
                window.dataset.prevWidth = window.style.width;
                window.dataset.prevHeight = window.style.height;
                window.dataset.prevTop = window.style.top;
                window.dataset.prevLeft = window.style.left;
                
                // Maximize window
                window.style.width = '100%';
                window.style.height = 'calc(100% - 28px)';
                window.style.top = '0';
                window.style.left = '0';
                window.classList.add('maximized');
            }
            
            // Scroll chat messages to bottom if this is a chat window
            const messagesContainer = window.querySelector('.chat-messages');
            if (messagesContainer) {
                setTimeout(() => {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }, 10);
            }
        });
        
        // Touch events for mobile
        header.addEventListener('touchstart', e => {
            const touch = e.touches[0];
            startDragging(touch);
        });
        document.addEventListener('touchmove', e => {
            e.preventDefault();
            const touch = e.touches[0];
            drag(touch);
        });
        document.addEventListener('touchend', stopDragging);
        
        function startDragging(e) {
            // Don't start dragging if clicking window controls
            if (e.target.classList.contains('control-button')) return;
            
            isDragging = true;
            window.style.transition = 'none';
            
            if (e.clientX) {
                // Mouse event
                initialX = e.clientX - window.offsetLeft;
                initialY = e.clientY - window.offsetTop;
            } else {
                // Touch event
                initialX = e.pageX - window.offsetLeft;
                initialY = e.pageY - window.offsetTop;
            }
            
            // Bring window to front when starting to drag
            bringToFront(window);
        }
        
        function drag(e) {
            if (!isDragging) return;
            
            e.preventDefault();
            
            if (e.clientX) {
                // Mouse event
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
            } else {
                // Touch event
                currentX = e.pageX - initialX;
                currentY = e.pageY - initialY;
            }
            
            // Keep window within viewport bounds
            const maxX = window.parentElement.clientWidth - window.offsetWidth;
            const maxY = window.parentElement.clientHeight - window.offsetHeight;
            
            currentX = Math.max(0, Math.min(currentX, maxX));
            currentY = Math.max(0, Math.min(currentY, maxY));
            
            window.style.left = currentX + 'px';
            window.style.top = currentY + 'px';
        }
        
        function stopDragging() {
            isDragging = false;
            window.style.transition = '';
        }
    });
}

// ============================================================================
// Buddy icon presets + upload (Phase 3.2)
// ----------------------------------------------------------------------------
// Server stores avatar_icon as a base64 PNG data URL. We give users two ways
// to set one: pick from a built-in preset grid, or upload an image (which we
// downscale to 64×64 in a canvas to keep the payload small).
// ============================================================================

// Inline SVG presets — rendered to 64×64 PNG data URLs on first use, then
// cached. SVG sources are short hand-rolled icons (smileys, sparkles, etc.)
// in different colors so the picker feels period-correct without shipping
// any image files.
const AIM_AVATAR_PRESET_SVGS = [
    // smiley yellow
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ffd84d"/><circle cx="22" cy="26" r="4" fill="#000"/><circle cx="42" cy="26" r="4" fill="#000"/><path d="M18 38 Q32 50 46 38" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/></svg>`,
    // wink blue
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#7fb3ff"/><path d="M16 24 L28 24" stroke="#000" stroke-width="3" stroke-linecap="round" fill="none"/><circle cx="42" cy="26" r="4" fill="#000"/><path d="M20 40 Q32 48 44 40" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/></svg>`,
    // heart pink
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ffb0c4"/><path d="M32 50 Q12 36 12 24 Q12 14 22 14 Q28 14 32 22 Q36 14 42 14 Q52 14 52 24 Q52 36 32 50 Z" fill="#e00040"/></svg>`,
    // star yellow on purple
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#7e3fb3"/><polygon points="32,10 38,26 56,26 42,36 48,52 32,42 16,52 22,36 8,26 26,26" fill="#ffd84d"/></svg>`,
    // skull
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1a1a"/><circle cx="32" cy="28" r="18" fill="#e8e8e8"/><rect x="28" y="44" width="8" height="8" fill="#e8e8e8"/><circle cx="24" cy="26" r="4" fill="#000"/><circle cx="40" cy="26" r="4" fill="#000"/></svg>`,
    // coffee brown
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#a87038"/><rect x="14" y="22" width="32" height="28" rx="3" fill="#fff" stroke="#000" stroke-width="2"/><path d="M46 28 L54 28 L54 38 L46 38" fill="none" stroke="#000" stroke-width="2"/><path d="M22 18 Q22 12 26 12" fill="none" stroke="#fff" stroke-width="2"/></svg>`,
    // music notes
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3fa860"/><circle cx="22" cy="44" r="6" fill="#000"/><circle cx="46" cy="40" r="6" fill="#000"/><path d="M28 44 L28 18 L52 14 L52 40" stroke="#000" stroke-width="3" fill="none"/></svg>`,
    // pixel cat
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ffcfa3"/><polygon points="14,30 20,16 26,30" fill="#000"/><polygon points="38,30 44,16 50,30" fill="#000"/><circle cx="32" cy="34" r="16" fill="#000"/><circle cx="26" cy="32" r="2" fill="#ffd84d"/><circle cx="38" cy="32" r="2" fill="#ffd84d"/></svg>`,
    // checker
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff"/><rect width="32" height="32" fill="#000"/><rect x="32" y="32" width="32" height="32" fill="#000"/></svg>`,
    // alien green
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0a0a14"/><ellipse cx="32" cy="36" rx="20" ry="22" fill="#7eff7e"/><ellipse cx="22" cy="34" rx="6" ry="9" fill="#000"/><ellipse cx="42" cy="34" rx="6" ry="9" fill="#000"/></svg>`,
];

// Render an SVG string to a PNG data URL via canvas. 64×64 to match the
// server-side size cap and keep storage tidy.
function svgToPngDataUrl(svgString) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0, 64, 64);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null);
        // URL-encode so the SVG round-trips through src cleanly.
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
    });
}

// User-uploaded file → 64×64 PNG data URL. Drops the original at upload to
// keep the server payload predictable.
function fileToPngDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        if (!/^image\/(png|jpe?g|gif)$/.test(file.type)) {
            return reject(new Error('Only PNG, JPEG, or GIF images are allowed.'));
        }
        if (file.size > 2 * 1024 * 1024) {
            return reject(new Error('Image too big (max 2 MB before resize).'));
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 64; canvas.height = 64;
                const ctx = canvas.getContext('2d');
                // Cover-fit so a non-square image still fills the avatar.
                const ratio = Math.max(64 / img.width, 64 / img.height);
                const w = img.width * ratio, h = img.height * ratio;
                ctx.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('Could not load that image.'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
    });
}

// ============================================================================
// Wallpaper picker (Phase 4.6) — right-click desktop opens a Win95 context
// menu with 6 wallpaper options. The chosen wallpaper is stored on the
// profile and applied via a body[data-wallpaper] CSS hook.
// ============================================================================

const AIM_WALLPAPERS = [
    { id: 'teal',     label: 'Teal (default)' },
    { id: 'bliss',    label: 'Bliss Green' },
    { id: 'forest',   label: 'Plus! Forest' },
    { id: 'clouds',   label: 'Clouds' },
    { id: 'mystify',  label: 'Mystify' },
    { id: 'plain',    label: 'Plain Gray' },
];

function applyWallpaper(id) {
    document.body.setAttribute('data-wallpaper', id || 'teal');
}

function ensureWallpaperPicker() {
    if (window._aimWallpaperBound) return;
    window._aimWallpaperBound = true;
    document.addEventListener('contextmenu', (e) => {
        const desktop = e.target.closest('.desktop');
        if (!desktop) return;
        e.preventDefault();
        showWallpaperMenu(e.clientX, e.clientY);
    });
}

function showWallpaperMenu(x, y) {
    document.querySelectorAll('.wallpaper-menu').forEach(el => el.remove());
    const menu = document.createElement('div');
    menu.className = 'wallpaper-menu';
    menu.innerHTML = `
        <div class="wallpaper-menu-header">Desktop Wallpaper</div>
        ${AIM_WALLPAPERS.map(w => `
            <div class="wallpaper-menu-item" data-wp="${w.id}">
                <div class="wallpaper-swatch wallpaper-swatch-${w.id}"></div>
                <span>${escapeHtml(w.label)}</span>
            </div>
        `).join('')}
    `;
    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.zIndex = 99999;
    document.body.appendChild(menu);

    menu.querySelectorAll('.wallpaper-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const wp = item.getAttribute('data-wp');
            applyWallpaper(wp);
            const profile = getUserProfile();
            profile.wallpaper = wp;
            saveUserProfile(profile);
            menu.remove();
        });
    });

    setTimeout(() => {
        const close = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', close, true);
            }
        };
        document.addEventListener('click', close, true);
    }, 0);
}

// ============================================================================
// Phase 4 toys & windows: Magic 8-Ball, Snake (Konami), Spectate, Leaderboard
// ============================================================================

// ---------- Magic 8-Ball (Phase 4.2) ----------

const MAGIC_8BALL_ANSWERS = [
    'It is certain.', 'Without a doubt.', 'Yes — definitely.', 'You may rely on it.',
    'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Signs point to yes.',
    'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.',
    'Cannot predict now.', 'Concentrate and ask again.',
    "Don't count on it.", 'My reply is no.', 'My sources say no.',
    'Outlook not so good.', 'Very doubtful.',
    'lol no.', 'idk, ask your mom.',
];

function showMagic8BallWindow() {
    let win = document.getElementById('magic8ball-window');
    if (!win) {
        win = document.createElement('div');
        win.id = 'magic8ball-window';
        win.className = 'window magic8ball-window';
        win.style.width = '320px';
        win.style.height = '380px';
        win.style.top = '120px';
        win.style.left = '260px';
        win.innerHTML = `
            <div class="window-header">
                <div class="window-title">Magic 8-Ball</div>
                <div class="window-controls">
                    <button class="control-button minimize" type="button">-</button>
                    <button class="control-button close" type="button">×</button>
                </div>
            </div>
            <div class="window-content magic8ball-content">
                <div class="magic8ball-ball" id="magic8ball-ball">
                    <div class="magic8ball-window-inner">
                        <div class="magic8ball-answer" id="magic8ball-answer">8</div>
                    </div>
                </div>
                <button class="win95-button magic8ball-shake-btn" id="magic8ball-shake">Shake it!</button>
                <p class="magic8ball-help">Ask a yes/no question, then shake.</p>
            </div>
        `;
        document.querySelector('.win95-container').appendChild(win);
        makeWindowsDraggable();

        const shake = () => {
            const ball = win.querySelector('#magic8ball-ball');
            const answerEl = win.querySelector('#magic8ball-answer');
            ball.classList.remove('magic8ball-shaking');
            // Force reflow so the animation restarts.
            void ball.offsetWidth;
            ball.classList.add('magic8ball-shaking');
            answerEl.style.opacity = '0';
            playSound('drop-sound');
            setTimeout(() => {
                const pick = MAGIC_8BALL_ANSWERS[Math.floor(Math.random() * MAGIC_8BALL_ANSWERS.length)];
                answerEl.textContent = pick;
                answerEl.style.opacity = '1';
            }, 700);
        };
        win.querySelector('#magic8ball-shake').addEventListener('click', shake);
        win.querySelector('#magic8ball-ball').addEventListener('click', shake);
    }
    showWindow('magic8ball-window');
}

// ---------- Snake (Phase 4.8 — Konami code or Start menu) ----------

const SNAKE_GRID = 20;       // cells per side
const SNAKE_CELL_PX = 14;    // pixels per cell
const SNAKE_TICK_MS = 130;

function showSnakeWindow() {
    let win = document.getElementById('snake-window');
    if (!win) {
        win = document.createElement('div');
        win.id = 'snake-window';
        win.className = 'window snake-window';
        win.style.width = `${SNAKE_GRID * SNAKE_CELL_PX + 24}px`;
        win.style.top = '100px';
        win.style.left = '240px';
        win.innerHTML = `
            <div class="window-header">
                <div class="window-title">Snake 🐍 — Arrows / WASD</div>
                <div class="window-controls">
                    <button class="control-button minimize" type="button">-</button>
                    <button class="control-button close" type="button">×</button>
                </div>
            </div>
            <div class="window-content snake-content">
                <div class="snake-hud">
                    <span>Score: <span id="snake-score">0</span></span>
                    <span>High: <span id="snake-high">${parseInt(localStorage.getItem('aim_snake_high') || '0', 10)}</span></span>
                </div>
                <canvas id="snake-canvas"
                        width="${SNAKE_GRID * SNAKE_CELL_PX}"
                        height="${SNAKE_GRID * SNAKE_CELL_PX}"></canvas>
                <div class="snake-controls">
                    <button class="win95-button" id="snake-start">Start</button>
                    <span class="snake-status" id="snake-status">Click Start, then use arrow keys.</span>
                </div>
            </div>
        `;
        document.querySelector('.win95-container').appendChild(win);
        makeWindowsDraggable();
        wireSnakeGame(win);
    }
    showWindow('snake-window');
}

function wireSnakeGame(win) {
    const canvas = win.querySelector('#snake-canvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = win.querySelector('#snake-score');
    const highEl  = win.querySelector('#snake-high');
    const statusEl = win.querySelector('#snake-status');
    const startBtn = win.querySelector('#snake-start');

    let snake, dir, pendingDir, apple, score, running, intervalId;

    function reset() {
        snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
        dir = { x: 1, y: 0 };
        pendingDir = dir;
        apple = randomApple();
        score = 0;
        scoreEl.textContent = '0';
        draw();
    }

    function randomApple() {
        for (let i = 0; i < 200; i++) {
            const a = {
                x: Math.floor(Math.random() * SNAKE_GRID),
                y: Math.floor(Math.random() * SNAKE_GRID),
            };
            if (!snake.some(s => s.x === a.x && s.y === a.y)) return a;
        }
        return { x: 0, y: 0 };
    }

    function tick() {
        // Allow at most one turn per tick — prevents reverse-into-self bug.
        dir = pendingDir;
        const head = snake[0];
        const next = { x: head.x + dir.x, y: head.y + dir.y };
        // Wall collision = death.
        if (next.x < 0 || next.x >= SNAKE_GRID || next.y < 0 || next.y >= SNAKE_GRID) {
            return gameOver();
        }
        // Self-collision = death.
        if (snake.some(s => s.x === next.x && s.y === next.y)) {
            return gameOver();
        }
        snake.unshift(next);
        if (next.x === apple.x && next.y === apple.y) {
            score++;
            scoreEl.textContent = String(score);
            apple = randomApple();
            playSound('gamemove-sound');
        } else {
            snake.pop();
        }
        draw();
    }

    function draw() {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Apple
        ctx.fillStyle = '#e02040';
        ctx.fillRect(apple.x * SNAKE_CELL_PX + 2, apple.y * SNAKE_CELL_PX + 2,
                     SNAKE_CELL_PX - 4, SNAKE_CELL_PX - 4);
        // Snake
        for (let i = 0; i < snake.length; i++) {
            ctx.fillStyle = i === 0 ? '#7fff7f' : '#3fa83f';
            ctx.fillRect(snake[i].x * SNAKE_CELL_PX + 1, snake[i].y * SNAKE_CELL_PX + 1,
                         SNAKE_CELL_PX - 2, SNAKE_CELL_PX - 2);
        }
        // Grid lines (subtle CRT vibe)
        ctx.strokeStyle = '#101410';
        for (let i = 0; i < SNAKE_GRID; i++) {
            ctx.beginPath();
            ctx.moveTo(i * SNAKE_CELL_PX, 0);
            ctx.lineTo(i * SNAKE_CELL_PX, canvas.height);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, i * SNAKE_CELL_PX);
            ctx.lineTo(canvas.width, i * SNAKE_CELL_PX);
            ctx.stroke();
        }
    }

    function gameOver() {
        running = false;
        clearInterval(intervalId);
        intervalId = null;
        const prevHigh = parseInt(localStorage.getItem('aim_snake_high') || '0', 10);
        if (score > prevHigh) {
            localStorage.setItem('aim_snake_high', String(score));
            highEl.textContent = String(score);
            statusEl.textContent = `Game over! New high score: ${score}.`;
            playSound('gamewin-sound');
        } else {
            statusEl.textContent = `Game over! Score: ${score}. High: ${prevHigh}.`;
            playSound('gameloss-sound');
        }
        startBtn.textContent = 'Restart';
    }

    function start() {
        reset();
        running = true;
        statusEl.textContent = 'Eat the red apple. Don\'t hit yourself.';
        startBtn.textContent = 'Restart';
        if (intervalId) clearInterval(intervalId);
        intervalId = setInterval(tick, SNAKE_TICK_MS);
        canvas.focus();
    }

    startBtn.addEventListener('click', start);

    // Keyboard handler scoped to when the window is foreground.
    const keyHandler = (e) => {
        if (win.style.display === 'none') return;
        // Only intercept arrow keys / WASD — leave everything else alone.
        const moves = {
            'ArrowUp': [0, -1], 'w': [0, -1], 'W': [0, -1],
            'ArrowDown': [0, 1], 's': [0, 1], 'S': [0, 1],
            'ArrowLeft': [-1, 0], 'a': [-1, 0], 'A': [-1, 0],
            'ArrowRight': [1, 0], 'd': [1, 0], 'D': [1, 0],
        };
        const m = moves[e.key];
        if (!m) return;
        e.preventDefault();
        // Reject reverse direction.
        if (m[0] === -dir.x && m[1] === -dir.y) return;
        pendingDir = { x: m[0], y: m[1] };
    };
    document.addEventListener('keydown', keyHandler);
    // Clean up when the window is closed.
    win.querySelector('.control-button.close').addEventListener('click', () => {
        if (intervalId) clearInterval(intervalId);
        document.removeEventListener('keydown', keyHandler);
    });

    draw();
}

// Konami code listener — global. Triggers Snake.
const KONAMI_SEQ = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown',
                    'ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
let konamiIdx = 0;
function ensureKonamiListener() {
    if (window._aimKonamiBound) return;
    window._aimKonamiBound = true;
    document.addEventListener('keydown', (e) => {
        // Skip if user is typing in an input field — would be infuriating.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
            konamiIdx = 0;
            return;
        }
        const expected = KONAMI_SEQ[konamiIdx];
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const exp = expected.length === 1 ? expected.toLowerCase() : expected;
        if (k === exp) {
            konamiIdx++;
            if (konamiIdx === KONAMI_SEQ.length) {
                konamiIdx = 0;
                playSound('gamewin-sound');
                showSnakeWindow();
            }
        } else {
            konamiIdx = 0;
        }
    });
}

// ---------- Spectate Games (Phase 4.3) ----------

function showSpectateWindow() {
    let win = document.getElementById('spectate-window');
    if (!win) {
        win = document.createElement('div');
        win.id = 'spectate-window';
        win.className = 'window spectate-window';
        win.style.width = '400px';
        win.style.height = '380px';
        win.style.top = '90px';
        win.style.left = '180px';
        win.innerHTML = `
            <div class="window-header">
                <div class="window-title">Spectate Games</div>
                <div class="window-controls">
                    <button class="control-button minimize" type="button">-</button>
                    <button class="control-button close" type="button">×</button>
                </div>
            </div>
            <div class="window-content spectate-content">
                <div class="toolbar">
                    <button class="win95-button" id="spectate-refresh">Refresh</button>
                </div>
                <div class="spectate-list" id="spectate-list">
                    <div class="loading">Looking for active games…</div>
                </div>
            </div>
        `;
        document.querySelector('.win95-container').appendChild(win);
        makeWindowsDraggable();
        win.querySelector('#spectate-refresh').addEventListener('click', refreshSpectateList);
    }
    showWindow('spectate-window');
    refreshSpectateList();
}

function refreshSpectateList() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'list_active_games' }));
}

function handleActiveGamesList(data) {
    const list = document.querySelector('#spectate-list');
    if (!list) return;
    const games = data.games || [];
    if (games.length === 0) {
        list.innerHTML = '<div class="mail-empty">No games in progress right now.</div>';
        return;
    }
    list.innerHTML = games.map(g => `
        <div class="spectate-row">
            <div class="spectate-row-icon">${gameLabelEmoji(g.gameType)}</div>
            <div class="spectate-row-body">
                <div class="spectate-row-title">${escapeHtml(gameLabel(g.gameType))}</div>
                <div class="spectate-row-players">
                    <span class="clickable-nick" data-nick="${escapeHtml(g.players[0])}">${escapeHtml(g.players[0])}</span>
                    vs
                    <span class="clickable-nick" data-nick="${escapeHtml(g.players[1])}">${escapeHtml(g.players[1])}</span>
                </div>
            </div>
            <button class="win95-button" data-game-id="${escapeHtml(g.gameId)}" data-game-type="${escapeHtml(g.gameType)}" data-players="${escapeHtml(g.players.join('|'))}">Watch</button>
        </div>
    `).join('');
    list.querySelectorAll('button[data-game-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const gameId = btn.getAttribute('data-game-id');
            const gameType = btn.getAttribute('data-game-type');
            const players = btn.getAttribute('data-players').split('|');
            const opp = players.find(p => p !== userInfo.nickname) || players[0];
            createGameWindow({ gameId, gameType, opponent: opp });
            socket.send(JSON.stringify({ type: 'game_spectate', gameId }));
        });
    });
}

function gameLabelEmoji(gameType) {
    return { ttt: '⭕', rps: '✂️', c4: '🔴', hangman: '🪢' }[gameType] || '🎮';
}

// ---------- Leaderboard (Phase 4.4) ----------

function showLeaderboardWindow() {
    let win = document.getElementById('leaderboard-window');
    if (!win) {
        win = document.createElement('div');
        win.id = 'leaderboard-window';
        win.className = 'window leaderboard-window';
        win.style.width = '420px';
        win.style.height = '460px';
        win.style.top = '80px';
        win.style.left = '210px';
        const tabs = AIM_GAME_CATALOG.map((g, i) => `
            <button class="leaderboard-tab${i === 0 ? ' active' : ''}" data-game="${g.id}">${escapeHtml(g.label)}</button>
        `).join('');
        win.innerHTML = `
            <div class="window-header">
                <div class="window-title">🏆 Top Players</div>
                <div class="window-controls">
                    <button class="control-button minimize" type="button">-</button>
                    <button class="control-button close" type="button">×</button>
                </div>
            </div>
            <div class="window-content leaderboard-content">
                <div class="leaderboard-tabs">${tabs}</div>
                <div class="leaderboard-body" id="leaderboard-body">
                    <div class="loading">Loading…</div>
                </div>
            </div>
        `;
        document.querySelector('.win95-container').appendChild(win);
        makeWindowsDraggable();
        win.querySelectorAll('.leaderboard-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                win.querySelectorAll('.leaderboard-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                loadLeaderboard(tab.getAttribute('data-game'));
            });
        });
    }
    showWindow('leaderboard-window');
    loadLeaderboard(AIM_GAME_CATALOG[0].id);
}

function loadLeaderboard(gameType) {
    const body = document.querySelector('#leaderboard-body');
    if (!body) return;
    body.innerHTML = '<div class="loading">Loading…</div>';
    fetch(`backend.php?endpoint=get-leaderboard&game_type=${encodeURIComponent(gameType)}&limit=10`,
          { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => {
            if (!data || !data.success) {
                body.innerHTML = '<div class="loading error">Could not load leaderboard.</div>';
                return;
            }
            const rows = data.leaderboard || [];
            if (rows.length === 0) {
                body.innerHTML = '<div class="mail-empty">No games yet — be the first!</div>';
                return;
            }
            body.innerHTML = `
                <table class="leaderboard-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Player</th>
                            <th>W</th><th>L</th><th>D</th>
                            <th>Win %</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((row, i) => `
                            <tr class="${row.player === userInfo.nickname ? 'leaderboard-row-me' : ''}">
                                <td class="leaderboard-rank">${i + 1}${i === 0 ? ' 🥇' : i === 1 ? ' 🥈' : i === 2 ? ' 🥉' : ''}</td>
                                <td class="clickable-nick" data-nick="${escapeHtml(row.player)}">${escapeHtml(row.player)}</td>
                                <td class="stat-w">${row.wins}</td>
                                <td class="stat-l">${row.losses}</td>
                                <td class="stat-d">${row.draws}</td>
                                <td>${row.win_pct}%</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        });
}

// ============================================================================
// Mail / Message archive (Phase 3.8)
// ----------------------------------------------------------------------------
// Polls get-unread-dms periodically; updates the taskbar badge; pops the
// "You've got mail!" chime when the count crosses 0 → N. Click the mailbox
// → opens the Mail window listing senders + recent messages, then marks
// read so the badge clears.
// ============================================================================

let aimLastUnreadCount = 0;
let aimMailRefreshInterval = null;
const AIM_MAIL_POLL_MS = 30_000;

function startMailPolling() {
    if (aimMailRefreshInterval) return;
    refreshMailbox();
    aimMailRefreshInterval = setInterval(refreshMailbox, AIM_MAIL_POLL_MS);
    const mb = document.getElementById('taskbar-mailbox');
    if (mb && !mb._wired) {
        mb._wired = true;
        mb.addEventListener('click', () => showMailWindow());
    }
}

function refreshMailbox() {
    fetch('backend.php?endpoint=get-unread-dms', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => {
            if (!data || !data.success) return;
            const count = data.total_unread || 0;
            updateMailboxBadge(count);
            if (count > aimLastUnreadCount && aimLastUnreadCount === 0) {
                playSound('gotmail-sound');
            }
            aimLastUnreadCount = count;
        })
        .catch(err => console.warn('mailbox refresh failed:', err));
}

function updateMailboxBadge(count) {
    const badge = document.getElementById('taskbar-mailbox-count');
    const mb = document.getElementById('taskbar-mailbox');
    if (!badge || !mb) return;
    badge.textContent = String(count);
    mb.classList.toggle('has-mail', count > 0);
}

function showMailWindow() {
    let win = document.getElementById('mail-window');
    if (!win) {
        win = document.createElement('div');
        win.id = 'mail-window';
        win.className = 'window mail-window';
        win.style.width = '420px';
        win.style.height = '420px';
        win.style.top = '70px';
        win.style.left = '180px';
        win.innerHTML = `
            <div class="window-header">
                <div class="window-title">You've Got Mail</div>
                <div class="window-controls">
                    <button class="control-button minimize" type="button">-</button>
                    <button class="control-button maximize" type="button">□</button>
                    <button class="control-button close" type="button">×</button>
                </div>
            </div>
            <div class="window-content mail-window-content">
                <div class="toolbar">
                    <button class="win95-button" id="mail-refresh">Refresh</button>
                    <button class="win95-button" id="mail-mark-all">Mark all read</button>
                </div>
                <div class="mail-list" id="mail-list">
                    <div class="loading">Loading mail…</div>
                </div>
            </div>
        `;
        document.querySelector('.win95-container').appendChild(win);
        makeWindowsDraggable();
        win.querySelector('#mail-refresh').addEventListener('click', () => populateMailWindow());
        win.querySelector('#mail-mark-all').addEventListener('click', () => {
            window.apiPost('mark-mail-seen', {})
                .then(r => r.json())
                .then(() => {
                    updateMailboxBadge(0);
                    aimLastUnreadCount = 0;
                    populateMailWindow();
                });
        });
    }
    showWindow('mail-window');
    populateMailWindow();
    // Opening the mail window IS reading; mark it.
    window.apiPost('mark-mail-seen', {})
        .then(r => r.json())
        .then(() => {
            updateMailboxBadge(0);
            aimLastUnreadCount = 0;
        });
}

function populateMailWindow() {
    const list = document.querySelector('#mail-list');
    if (!list) return;
    list.innerHTML = '<div class="loading">Loading mail…</div>';
    fetch('backend.php?endpoint=get-unread-dms', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => {
            if (!data || !data.success) {
                list.innerHTML = '<div class="loading error">Could not load mail.</div>';
                return;
            }
            const bySender = data.by_sender || [];
            if (bySender.length === 0) {
                list.innerHTML = '<div class="mail-empty">No new mail — you\'re all caught up!</div>';
                return;
            }
            list.innerHTML = bySender.map(row => `
                <div class="mail-row" data-sender="${escapeHtml(row.sender)}">
                    <div class="mail-row-avatar">${escapeHtml(row.sender.charAt(0).toUpperCase())}</div>
                    <div class="mail-row-body">
                        <div class="mail-row-sender clickable-nick" data-nick="${escapeHtml(row.sender)}">${escapeHtml(row.sender)}</div>
                        <div class="mail-row-preview">${renderRichMessage(row.latest_message || '')}</div>
                        <div class="mail-row-meta">${formatTimestamp(row.latest_timestamp)} · ${row.unread_count} unread</div>
                    </div>
                    <button class="win95-button mail-row-open" data-sender="${escapeHtml(row.sender)}">Open IM</button>
                </div>
            `).join('');
            list.querySelectorAll('.mail-row-open').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showDirectMessageWindow(btn.getAttribute('data-sender'));
                });
            });
        });
}

// Phase 3.6: small Win95 toast that pops above the taskbar when a buddy
// comes online (or signs off). Auto-dismisses after a few seconds. Stacks
// vertically so two buddies signing on at once don't overlap.
const AIM_BUDDY_TOAST_STACK = [];
function showBuddyToast(nickname, what) {
    const toast = document.createElement('div');
    toast.className = `buddy-toast buddy-toast-${what === 'signed on' ? 'on' : 'off'}`;
    toast.innerHTML = `
        <div class="buddy-toast-avatar">${escapeHtml(nickname.charAt(0).toUpperCase())}</div>
        <div class="buddy-toast-body">
            <div class="buddy-toast-title clickable-nick" data-nick="${escapeHtml(nickname)}">${escapeHtml(nickname)}</div>
            <div class="buddy-toast-sub">${what}</div>
        </div>
    `;
    document.body.appendChild(toast);
    AIM_BUDDY_TOAST_STACK.push(toast);
    // Position above taskbar, stacking upward.
    const recompute = () => {
        let y = 36;
        for (let i = AIM_BUDDY_TOAST_STACK.length - 1; i >= 0; i--) {
            const t = AIM_BUDDY_TOAST_STACK[i];
            t.style.bottom = `${y}px`;
            y += t.offsetHeight + 6;
        }
    };
    recompute();

    setTimeout(() => {
        toast.classList.add('buddy-toast-leaving');
        setTimeout(() => {
            toast.remove();
            const i = AIM_BUDDY_TOAST_STACK.indexOf(toast);
            if (i >= 0) AIM_BUDDY_TOAST_STACK.splice(i, 1);
            recompute();
        }, 250);
    }, 4000);
}

// Update active rooms count
function updateActiveRoomsCount() {
    const chatWindows = document.querySelectorAll('.chat-window');
    const count = Array.from(chatWindows).filter(window =>
        window.id !== 'chat-window-template' &&
        window.style.display !== 'none'
    ).length;

    const activeRoomsCount = document.getElementById('active-rooms-count');
    if (activeRoomsCount) {
        activeRoomsCount.textContent = count;
    }
}

// ============================================================================
// Games module — Phase 1 scaffolding
// ----------------------------------------------------------------------------
// The wire protocol is implemented in lib/core.js (server side). Phase 1
// ships everything the user can see: a Challenge dropdown, an invite dialog,
// the game window chrome, and a friendly "Coming Soon" path when a game
// type has no spec registered yet. Phase 2 will register the actual game
// logic and the boards will paint themselves into .game-board.
// ============================================================================

// Catalog of game types the Challenge menu offers. Order matters — first
// entry is the default. Each `id` is the gameType string sent to the server.
const AIM_GAME_CATALOG = [
    { id: 'ttt',     label: 'Tic Tac Toe' },
    { id: 'rps',     label: 'Rock Paper Scissors' },
    { id: 'c4',      label: 'Connect Four' },
    { id: 'hangman', label: 'Hangman' },
];

// Tracks game windows currently open in this tab so incoming game_state
// pushes find their DOM. Keyed by gameId.
const aimOpenGameWindows = new Map();

// Win95 modal: title + message + OK button. Used for the "Coming Soon"
// state, network errors, and any other one-shot acknowledgements.
function showInfoDialog({ title = 'AIM Chat', message = '', okLabel = 'OK', onOk } = {}) {
    const dlg = document.createElement('div');
    dlg.className = 'window dialog info-dialog';
    dlg.style.width = '340px';
    dlg.innerHTML = `
        <div class="window-header">
            <div class="window-title">${escapeHtml(title)}</div>
            <div class="window-controls">
                <button class="control-button close" type="button">×</button>
            </div>
        </div>
        <div class="window-content">
            <div class="info-dialog-body">${message}</div>
            <div class="dialog-buttons">
                <button class="win95-button primary-button info-ok" type="button">${escapeHtml(okLabel)}</button>
            </div>
        </div>
    `;
    document.querySelector('.win95-container').appendChild(dlg);
    makeWindowsDraggable();
    const close = () => { dlg.remove(); if (typeof onOk === 'function') onOk(); };
    dlg.querySelector('.info-ok').onclick = close;
    dlg.querySelector('.control-button.close').onclick = close;
    dlg.style.display = 'flex';
    bringToFront(dlg);
}

// Renders the Challenge dropdown menu. Anchors below the triggering button.
function showChallengeMenu(anchorEl, opponent) {
    // Close any existing menu first so only one is open at a time.
    document.querySelectorAll('.challenge-menu').forEach(el => el.remove());

    const menu = document.createElement('div');
    menu.className = 'challenge-menu';
    menu.innerHTML = AIM_GAME_CATALOG.map(g =>
        `<div class="challenge-menu-item" data-game="${g.id}">🎮 ${escapeHtml(g.label)}</div>`
    ).join('');
    document.body.appendChild(menu);

    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 2}px`;
    menu.style.zIndex = 99999;

    menu.querySelectorAll('.challenge-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const gameType = item.getAttribute('data-game');
            menu.remove();
            sendGameInvite(opponent, gameType);
        });
    });

    // Click-anywhere-else to close
    setTimeout(() => {
        const handler = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', handler, true);
            }
        };
        document.addEventListener('click', handler, true);
    }, 0);
}

// Globally exposed because the inline onclick in buddy-list rows / DM headers
// can't see closure-scoped functions.
window.handleChallengeClick = function (btn, opponent) {
    showChallengeMenu(btn, opponent);
};

// Click delegation: any element with .clickable-nick opens that user's
// read-only profile window. Set up once on first call.
function ensureClickableNickDelegation() {
    if (window._aimNickDelegationBound) return;
    window._aimNickDelegationBound = true;
    document.addEventListener('click', (e) => {
        const el = e.target.closest('.clickable-nick');
        if (!el) return;
        const nick = el.getAttribute('data-nick');
        if (!nick) return;
        e.stopPropagation();
        if (nick === userInfo.nickname) {
            showProfileWindow();      // your own profile, editable
        } else {
            showOtherProfileWindow(nick);
        }
    });
}

// Read-only "Buddy Info" window for another user. Built fresh each time so
// stats / status are always up to date; close to dismiss.
function showOtherProfileWindow(nickname) {
    // Reuse a single window per nickname so spam-clicking doesn't stack
    // duplicates on the desktop.
    const id = `other-profile-${nickname.replace(/[^a-zA-Z0-9]/g, '')}`;
    let win = document.getElementById(id);
    if (win) {
        showWindow(id);
        return;
    }

    win = document.createElement('div');
    win.id = id;
    win.className = 'window other-profile-window';
    win.style.width = '380px';
    win.style.height = 'auto';
    win.style.top = '90px';
    win.style.left = '200px';
    win.innerHTML = `
        <div class="window-header">
            <div class="window-title">Buddy Info: ${escapeHtml(nickname)}</div>
            <div class="window-controls">
                <button class="control-button close" type="button">×</button>
            </div>
        </div>
        <div class="window-content">
            <div class="other-profile-body" id="${id}-body">
                <div class="loading">Loading buddy info…</div>
            </div>
            <div class="other-profile-actions">
                <button class="win95-button" data-action="im">Send IM</button>
                <button class="win95-button" data-action="challenge">🎮 Challenge</button>
                <button class="win95-button" data-action="add-buddy">Add Buddy</button>
            </div>
        </div>
    `;
    document.querySelector('.win95-container').appendChild(win);
    makeWindowsDraggable();

    // Wire footer buttons.
    win.querySelector('[data-action="im"]').addEventListener('click', () => {
        showDirectMessageWindow(nickname);
    });
    win.querySelector('[data-action="challenge"]').addEventListener('click', (e) => {
        showChallengeMenu(e.currentTarget, nickname);
    });
    const addBuddyBtn = win.querySelector('[data-action="add-buddy"]');
    addBuddyBtn.addEventListener('click', () => {
        if (isBuddy(nickname)) {
            removeBuddyEntry(nickname);
            playSound('buddyout-sound');
            addBuddyBtn.textContent = 'Add Buddy';
        } else {
            addBuddy(nickname);
            playSound('buddyin-sound');
            addBuddyBtn.textContent = 'Remove Buddy';
        }
    });
    if (isBuddy(nickname)) addBuddyBtn.textContent = 'Remove Buddy';

    showWindow(id);

    // Fetch profile + stats in parallel.
    const body = win.querySelector(`#${id}-body`);
    Promise.all([
        fetch(`backend.php?endpoint=get-profile&username=${encodeURIComponent(nickname)}`, { credentials: 'same-origin' })
            .then(r => r.json()),
        fetch(`backend.php?endpoint=get-stats&username=${encodeURIComponent(nickname)}`, { credentials: 'same-origin' })
            .then(r => r.json()),
    ]).then(([profileResp, statsResp]) => {
        const p = (profileResp && profileResp.success) ? profileResp.profile : null;
        if (!p) {
            body.innerHTML = '<div class="loading error">Could not load buddy info.</div>';
            return;
        }
        const statusLabels = {
            online: '● Online', away: '◐ Away',
            invisible: '○ Invisible', offline: '✕ Offline',
        };
        const displayName = p.display_name || nickname;
        const statusKey = p.status || 'online';
        const avatarColor = p.avatar_color || '#007BFF';
        const initial = (displayName.charAt(0) || nickname.charAt(0)).toUpperCase();
        const avatarHtml = p.avatar_icon
            ? `<img src="${escapeHtml(p.avatar_icon)}" alt="avatar">`
            : initial;

        // Stats rows.
        const statsRows = AIM_GAME_CATALOG.map(g => {
            const s = (statsResp.stats || []).find(s => s.game_type === g.id)
                   || { wins: 0, losses: 0, draws: 0 };
            return `
                <div class="profile-stats-row">
                    <div class="profile-stats-label">${escapeHtml(g.label)}</div>
                    <div class="profile-stats-record">
                        <span class="stat-w">${s.wins}W</span>
                        <span class="stat-l">${s.losses}L</span>
                        <span class="stat-d">${s.draws}D</span>
                    </div>
                </div>
            `;
        }).join('');

        body.innerHTML = `
            <div class="other-profile-header">
                <div class="other-profile-avatar" style="background-color: ${escapeHtml(avatarColor)}">${avatarHtml}</div>
                <div class="other-profile-name-block">
                    <div class="other-profile-name">${escapeHtml(displayName)}</div>
                    <div class="other-profile-nickname">@${escapeHtml(nickname)}</div>
                    <div class="other-profile-status status-${escapeHtml(statusKey)}">${statusLabels[statusKey] || statusKey}</div>
                </div>
            </div>
            ${statusKey === 'away' && p.away_message ? `
                <div class="other-profile-away">
                    <strong>Away Message:</strong>
                    <div class="other-profile-away-text">${renderRichMessage(p.away_message)}</div>
                </div>
            ` : ''}
            <div class="other-profile-section">
                <div class="other-profile-section-label">Bio</div>
                <div class="other-profile-bio">${renderRichMessage(p.bio || '(no bio set)')}</div>
            </div>
            <div class="other-profile-section">
                <div class="other-profile-section-label">Game Record</div>
                <div class="profile-stats">${statsRows}</div>
            </div>
        `;
    }).catch(err => {
        console.warn('showOtherProfileWindow load failed:', err);
        body.innerHTML = '<div class="loading error">Could not load buddy info.</div>';
    });
}

// Send a game_invite to the server. The server records the game, forwards
// to the recipient, and drops a receipt in the DM thread (persisted to
// SQLite via Phase 1.3 persistence).
function sendGameInvite(opponent, gameType) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showInfoDialog({ title: 'Disconnected',
            message: 'You\'re not connected to the chat server right now.' });
        playSound('error-sound');
        return;
    }
    socket.send(JSON.stringify({
        type: 'game_invite',
        to: opponent,
        gameType,
    }));
    playSound('challenge-sound');
    showInfoDialog({
        title: 'Challenge Sent',
        message: `Waiting for <b>${escapeHtml(opponent)}</b> to accept your ${escapeHtml(gameLabel(gameType))} challenge…`,
    });
}

function gameLabel(gameType) {
    const found = AIM_GAME_CATALOG.find(g => g.id === gameType);
    return found ? found.label : gameType;
}

// Fetches W/L/D aggregate from backend.php and renders into the given
// selector. Used by the profile window (and any future Buddy Info panes).
function loadStatsInto(selector, username) {
    const root = document.querySelector(selector);
    if (!root) return;
    fetch(`backend.php?endpoint=get-stats&username=${encodeURIComponent(username)}`,
          { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => {
            if (!data || !data.success) {
                root.innerHTML = '<div class="profile-stats-empty">Could not load stats.</div>';
                return;
            }
            // Always show all known game types so 0-record games are visible too.
            const seen = new Map();
            for (const row of data.stats || []) seen.set(row.game_type, row);
            const lines = AIM_GAME_CATALOG.map(g => {
                const r = seen.get(g.id) || { wins: 0, losses: 0, draws: 0 };
                return `
                    <div class="profile-stats-row">
                        <div class="profile-stats-label">${escapeHtml(g.label)}</div>
                        <div class="profile-stats-record">
                            <span class="stat-w">${r.wins}W</span>
                            <span class="stat-l">${r.losses}L</span>
                            <span class="stat-d">${r.draws}D</span>
                        </div>
                    </div>
                `;
            });
            root.innerHTML = lines.join('') ||
                '<div class="profile-stats-empty">No games played yet.</div>';
        })
        .catch(err => {
            console.warn('get-stats failed:', err);
            root.innerHTML = '<div class="profile-stats-empty">Could not load stats.</div>';
        });
}

// Incoming invite from another user. Renders the classic AIM accept/decline
// modal with the challenge chime.
function showIncomingInviteDialog({ from, gameType, gameId }) {
    playSound('challenge-sound');
    const dlg = document.createElement('div');
    dlg.className = 'window dialog game-invite-dialog';
    dlg.style.width = '360px';
    dlg.innerHTML = `
        <div class="window-header">
            <div class="window-title">Game Challenge</div>
            <div class="window-controls">
                <button class="control-button close" type="button">×</button>
            </div>
        </div>
        <div class="window-content">
            <div class="info-dialog-body">
                <strong>${escapeHtml(from)}</strong> wants to play
                <strong>${escapeHtml(gameLabel(gameType))}</strong> with you.
            </div>
            <div class="dialog-buttons">
                <button class="win95-button primary-button invite-accept" type="button">Accept</button>
                <button class="win95-button invite-decline" type="button">Decline</button>
            </div>
        </div>
    `;
    document.querySelector('.win95-container').appendChild(dlg);
    makeWindowsDraggable();

    const close = () => dlg.remove();
    dlg.querySelector('.invite-accept').onclick = () => {
        socket.send(JSON.stringify({ type: 'game_accept', gameId }));
        close();
    };
    dlg.querySelector('.invite-decline').onclick = () => {
        socket.send(JSON.stringify({ type: 'game_decline', gameId }));
        close();
    };
    dlg.querySelector('.control-button.close').onclick = () => {
        socket.send(JSON.stringify({ type: 'game_decline', gameId }));
        close();
    };
    dlg.style.display = 'flex';
    bringToFront(dlg);
}

// Clone #game-window-template and wire it up. Returns the new DOM node.
// Phase 2 will fill .game-board via game-type-specific renderers; Phase 1
// just shows the chrome with placeholder copy.
function createGameWindow({ gameId, gameType, opponent }) {
    const existing = aimOpenGameWindows.get(gameId);
    if (existing && document.body.contains(existing)) {
        bringToFront(existing);
        existing.style.display = 'flex';
        return existing;
    }
    const template = document.getElementById('game-window-template');
    if (!template) {
        console.error('createGameWindow: #game-window-template not found in DOM');
        return null;
    }
    const win = template.cloneNode(true);
    win.id = `game-window-${gameId}`;
    win.dataset.gameId = gameId;
    win.dataset.gameType = gameType;
    win.dataset.opponent = opponent;
    win.style.display = 'flex';

    // Position with a small stagger so multiple concurrent games don't stack.
    const offset = aimOpenGameWindows.size * 24;
    win.style.top = `${110 + offset}px`;
    win.style.left = `${140 + offset}px`;
    win.style.width = '480px';
    win.style.height = '520px';

    win.querySelector('.window-title').textContent =
        `${gameLabel(gameType)} vs ${opponent}`;
    const opponentNameEl = win.querySelector('.game-opponent-name');
    opponentNameEl.textContent = opponent;
    opponentNameEl.classList.add('clickable-nick');
    opponentNameEl.setAttribute('data-nick', opponent);
    const avatar = win.querySelector('.game-opponent-avatar');
    avatar.textContent = opponent.charAt(0).toUpperCase();
    avatar.style.backgroundColor =
        '#' + (Array.from(opponent).reduce((h, c) => h * 31 + c.charCodeAt(0), 0) & 0xffffff)
            .toString(16).padStart(6, '0');

    document.querySelector('.win95-container').appendChild(win);
    makeWindowsDraggable();

    // Pull the opponent's record (and avatar) into the header chip.
    Promise.all([
        fetch(`backend.php?endpoint=get-stats&username=${encodeURIComponent(opponent)}`,   { credentials: 'same-origin' }).then(r => r.json()),
        fetch(`backend.php?endpoint=get-profile&username=${encodeURIComponent(opponent)}`, { credentials: 'same-origin' }).then(r => r.json()),
    ]).then(([statsResp, profileResp]) => {
        if (statsResp && statsResp.success) {
            const record = win.querySelector('.game-opponent-record');
            const row = (statsResp.stats || []).find(s => s.game_type === gameType);
            if (record) record.textContent = row ? `${row.wins}W – ${row.losses}L` : '0W – 0L';
        }
        if (profileResp && profileResp.success && profileResp.profile) {
            const p = profileResp.profile;
            const av = win.querySelector('.game-opponent-avatar');
            if (av) {
                if (p.avatar_icon) {
                    av.innerHTML = `<img src="${escapeHtml(p.avatar_icon)}" alt="">`;
                }
                if (p.avatar_color) av.style.backgroundColor = p.avatar_color;
            }
        }
    }).catch(() => {});

    // Wire chat strip — game-chat-text is the input; we shoehorn it into a
    // .chat-input wrapper for wireChatToolbar() so it gets a toolbar too.
    const chatInput = win.querySelector('.game-chat-text');
    const chatSend = win.querySelector('.game-chat-send');
    const chatInputWrap = win.querySelector('.game-chat-input');
    if (chatInputWrap && !chatInputWrap.classList.contains('chat-input')) {
        chatInputWrap.classList.add('chat-input');
    }
    const toolbar = wireChatToolbar(chatInput);
    const sendChat = () => {
        const raw = chatInput.value.trim();
        if (!raw) return;
        const message = toolbar.encodeFor(raw);
        socket.send(JSON.stringify({ type: 'game_chat', gameId, message }));
        chatInput.value = '';
    };
    chatSend.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    // Wire Resign / Rematch
    win.querySelector('.game-resign-btn').addEventListener('click', () => {
        if (!confirm('Resign this game?')) return;
        socket.send(JSON.stringify({ type: 'game_resign', gameId }));
    });
    win.querySelector('.game-rematch-btn').addEventListener('click', () => {
        socket.send(JSON.stringify({ type: 'game_invite', to: opponent, gameType }));
    });

    aimOpenGameWindows.set(gameId, win);
    showWindow(win.id);
    return win;
}

function appendGameChatLine(gameId, from, message) {
    const win = aimOpenGameWindows.get(gameId);
    if (!win) return;
    const log = win.querySelector('.game-chat-messages');
    const line = document.createElement('div');
    line.className = 'game-chat-line';
    line.innerHTML = `<span class="game-chat-from clickable-nick" data-nick="${escapeHtml(from)}">${escapeHtml(from)}:</span> ${renderRichMessage(message)}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

function setGameStatusChip(gameId, text) {
    const win = aimOpenGameWindows.get(gameId);
    if (!win) return;
    const chip = win.querySelector('.game-status-chip');
    if (chip) chip.textContent = text;
}

function setGameBoardMessage(gameId, html) {
    const win = aimOpenGameWindows.get(gameId);
    if (!win) return;
    const board = win.querySelector('.game-board');
    if (board) board.innerHTML = `<div class="game-board-empty">${html}</div>`;
}

// ---------- WS event handlers (called from connectToWebSocket onmessage) ----

function handleGameInvite(data) {
    // Sender's own receipt — server echoes the invite back so the UI can show
    // "waiting for X to accept". The showInfoDialog from sendGameInvite()
    // already covers this so we just no-op here.
    if (data.direction === 'outbound' || data.from === userInfo.nickname) return;
    showIncomingInviteDialog({
        from: data.from,
        gameType: data.gameType,
        gameId: data.gameId,
    });
}

function handleGameAccept(data) {
    // Both players get this. Open the game window for both sides.
    const opponent = data.from === userInfo.nickname
        ? (data.players || []).find(p => p !== userInfo.nickname) || 'opponent'
        : data.from;
    createGameWindow({
        gameId: data.gameId,
        gameType: data.gameType || 'ttt',
        opponent,
    });
    setGameStatusChip(data.gameId, 'Game on!');
}

function handleGameDecline(data) {
    showInfoDialog({
        title: 'Challenge Declined',
        message: data.from
            ? `<b>${escapeHtml(data.from)}</b> declined your challenge.`
            : 'The challenge was declined.',
    });
    playSound('error-sound');
}

// Per-gameType board renderers. Each takes (gameId, state, data) and paints
// the board region of the game window. Registered below so the dispatch in
// handleGameState stays simple — adding a new game means writing one
// renderer and one GameSpec.
const AIM_GAME_RENDERERS = {};

function handleGameState(data) {
    const win = aimOpenGameWindows.get(data.gameId);
    if (!win) return;
    const renderer = AIM_GAME_RENDERERS[data.gameType];
    if (renderer) {
        renderer(data.gameId, data.state, data);
    } else {
        setGameStatusChip(data.gameId, 'Game in progress');
    }
    // Show a reconnect banner if the opponent's WS dropped — server sets
    // disconnectedPlayers when grace-period applies.
    if (Array.isArray(data.disconnectedPlayers) && data.disconnectedPlayers.length > 0) {
        setGameStatusChip(data.gameId, `Waiting for ${data.disconnectedPlayers.join(', ')} to reconnect…`);
    }
    if (!data.resumed) {
        playSound('gamemove-sound');
    }
}

function handleGameOver(data) {
    const win = aimOpenGameWindows.get(data.gameId);
    if (!win) return;
    // Render the final board state first so the player sees the winning move.
    const renderer = AIM_GAME_RENDERERS[data.gameType];
    if (renderer && data.state) {
        renderer(data.gameId, data.state, data);
    }
    const me = userInfo.nickname;
    let result, chip;
    if (!data.winner) {
        result = 'Draw.';
        chip = 'Draw';
        playSound('gametie-sound');
    } else if (data.winner === me) {
        result = 'You win! 🏆';
        chip = 'You win!';
        playSound('gamewin-sound');
    } else {
        result = `${escapeHtml(data.winner)} wins.`;
        chip = `${data.winner} wins`;
        playSound('gameloss-sound');
    }
    setGameStatusChip(data.gameId, chip);

    // Drop a result banner over the board without nuking the final position.
    const board = win.querySelector('.game-board');
    if (board) {
        const banner = document.createElement('div');
        banner.className = 'game-over-banner';
        banner.innerHTML = `<div class="game-over-text">${result}</div>`;
        board.appendChild(banner);
    }

    const rematch = win.querySelector('.game-rematch-btn');
    if (rematch) rematch.disabled = false;
    const resign = win.querySelector('.game-resign-btn');
    if (resign) resign.disabled = true;
}

// ---------------------------------------------------------------------------
// Tic Tac Toe renderer
// ---------------------------------------------------------------------------

AIM_GAME_RENDERERS.ttt = function renderTicTacToeBoard(gameId, state, data) {
    const win = aimOpenGameWindows.get(gameId);
    if (!win) return;
    const board = win.querySelector('.game-board');
    if (!board) return;

    const me = userInfo.nickname;
    const mySymbol = state.xPlayer === me ? 'X' : 'O';
    const isMyTurn = state.turn === mySymbol && !state.winner && data.status === 'active';
    const winningLine = state.winningLine || [];

    // Build the 3x3 grid. Use a single innerHTML pass so re-renders don't
    // flicker — every cell rebuilds from scratch each game_state.
    const cells = [];
    for (let i = 0; i < 9; i++) {
        const val = state.board[i];
        const isWinning = winningLine.includes(i);
        const cls = [
            'ttt-cell',
            val ? `ttt-cell-${val.toLowerCase()}` : 'ttt-cell-empty',
            isWinning ? 'ttt-cell-winning' : '',
        ].filter(Boolean).join(' ');
        cells.push(`
            <button class="${cls}" data-cell="${i}"
                    ${val || !isMyTurn ? 'disabled' : ''}
                    aria-label="cell ${i}, ${val || 'empty'}">
                ${val || ''}
            </button>
        `);
    }

    board.innerHTML = `
        <div class="ttt-wrap">
            <div class="ttt-grid">${cells.join('')}</div>
            <div class="ttt-legend">
                You are <strong>${mySymbol}</strong> ·
                X: ${escapeHtml(state.xPlayer)} ·
                O: ${escapeHtml(state.oPlayer)}
            </div>
        </div>
    `;

    // Wire click handlers — send game_move only on legal cells.
    board.querySelectorAll('.ttt-cell').forEach(btn => {
        btn.addEventListener('click', () => {
            const cell = parseInt(btn.getAttribute('data-cell'), 10);
            if (Number.isNaN(cell)) return;
            socket.send(JSON.stringify({
                type: 'game_move',
                gameId,
                move: { cell },
            }));
        });
    });

    // Status chip reflects whose turn it is.
    if (state.winner) {
        // handleGameOver paints the chip; nothing to do here.
    } else if (isMyTurn) {
        setGameStatusChip(gameId, `Your turn (${mySymbol})`);
    } else {
        const opponent = state.turn === 'X' ? state.xPlayer : state.oPlayer;
        setGameStatusChip(gameId, `Waiting for ${opponent} (${state.turn})…`);
    }
};

// ---------------------------------------------------------------------------
// Rock Paper Scissors renderer
// ---------------------------------------------------------------------------

const AIM_RPS_ICONS = { rock: '🪨', paper: '📄', scissors: '✂️' };

AIM_GAME_RENDERERS.rps = function renderRockPaperScissorsBoard(gameId, state, data) {
    const win = aimOpenGameWindows.get(gameId);
    if (!win) return;
    const board = win.querySelector('.game-board');
    if (!board) return;

    const me = userInfo.nickname;
    const opponent = Object.keys(state.scores).find(p => p !== me) || 'opponent';

    const myPick = state.picks[me];
    const oppPick = state.picks[opponent]; // '__hidden__' or null or my pick if I'm spectating

    const myScore = state.scores[me] || 0;
    const oppScore = state.scores[opponent] || 0;

    // Determine UI mode:
    //   - 'pick':       I haven't picked yet
    //   - 'wait':       I picked, waiting for opponent
    //   - 'reveal':     a new history entry just landed
    //   - 'over':       game ended
    const lastRendered = parseInt(win.dataset.rpsRenderedRounds || '0', 10);
    const isReveal = state.history.length > lastRendered;
    win.dataset.rpsRenderedRounds = String(state.history.length);

    const isOver = data.status === 'over' || !!data.winner;

    let mode = 'pick';
    if (isOver) mode = 'over';
    else if (isReveal) mode = 'reveal';
    else if (myPick) mode = 'wait';

    const scoreBar = `
        <div class="rps-scoreboard">
            <div class="rps-score-chip rps-me">You: ${myScore}</div>
            <div class="rps-round">Round ${Math.min(state.round, state.maxRounds)} of ${state.maxRounds}</div>
            <div class="rps-score-chip rps-them">${escapeHtml(opponent)}: ${oppScore}</div>
        </div>
    `;

    const pickButton = (opt) => `
        <button class="rps-button rps-${opt}"
                data-pick="${opt}"
                ${mode === 'pick' ? '' : 'disabled'}>
            <span class="rps-icon">${AIM_RPS_ICONS[opt]}</span>
            <span class="rps-label">${opt[0].toUpperCase()}${opt.slice(1)}</span>
        </button>
    `;

    let center;
    if (mode === 'reveal' && state.history.length > 0) {
        // Animated reveal of the most-recent round.
        const last = state.history[state.history.length - 1];
        const myReveal = last.picks[me];
        const theirReveal = last.picks[opponent];
        let result;
        if (last.winner == null) result = 'Tie!';
        else if (last.winner === me) result = 'You win the round!';
        else result = `${escapeHtml(opponent)} wins the round.`;
        center = `
            <div class="rps-reveal">
                <div class="rps-shoot">Rock… Paper… Scissors… <strong>Shoot!</strong></div>
                <div class="rps-reveal-row">
                    <div class="rps-reveal-side">
                        <div class="rps-reveal-label">You</div>
                        <div class="rps-reveal-pick">${AIM_RPS_ICONS[myReveal] || '?'}</div>
                    </div>
                    <div class="rps-reveal-vs">vs</div>
                    <div class="rps-reveal-side">
                        <div class="rps-reveal-label">${escapeHtml(opponent)}</div>
                        <div class="rps-reveal-pick">${AIM_RPS_ICONS[theirReveal] || '?'}</div>
                    </div>
                </div>
                <div class="rps-reveal-result">${result}</div>
            </div>
        `;
    } else if (mode === 'wait') {
        center = `
            <div class="rps-wait">
                <div class="rps-wait-msg">You picked <strong>${AIM_RPS_ICONS[myPick]} ${escapeHtml(myPick)}</strong></div>
                <div class="rps-wait-sub">Waiting for ${escapeHtml(opponent)}…</div>
            </div>
        `;
    } else if (mode === 'over') {
        center = `
            <div class="rps-buttons rps-buttons-disabled">
                ${['rock','paper','scissors'].map(pickButton).join('')}
            </div>
        `;
    } else {
        // Pick mode — opponent may or may not have already picked.
        const oppStatus = oppPick === '__hidden__'
            ? `<div class="rps-opp-status">${escapeHtml(opponent)} has picked. Your move.</div>`
            : `<div class="rps-opp-status">Make your move.</div>`;
        center = `
            ${oppStatus}
            <div class="rps-buttons">
                ${['rock','paper','scissors'].map(pickButton).join('')}
            </div>
        `;
    }

    board.innerHTML = `
        <div class="rps-wrap">
            ${scoreBar}
            <div class="rps-stage">
                ${center}
            </div>
        </div>
    `;

    // Wire pick buttons.
    board.querySelectorAll('.rps-button:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            const pick = btn.getAttribute('data-pick');
            socket.send(JSON.stringify({
                type: 'game_move',
                gameId,
                move: { pick },
            }));
        });
    });

    // Status chip.
    if (isOver) {
        // handleGameOver paints final chip.
    } else if (mode === 'reveal') {
        setGameStatusChip(gameId, 'Reveal!');
    } else if (mode === 'wait') {
        setGameStatusChip(gameId, `Waiting for ${opponent}…`);
    } else {
        setGameStatusChip(gameId, `Round ${state.round}: pick one`);
    }
};

// ---------------------------------------------------------------------------
// Connect Four renderer (Phase 4.1)
// ---------------------------------------------------------------------------

AIM_GAME_RENDERERS.c4 = function renderConnectFourBoard(gameId, state, data) {
    const win = aimOpenGameWindows.get(gameId);
    if (!win) return;
    const board = win.querySelector('.game-board');
    if (!board) return;

    const me = userInfo.nickname;
    const mySymbol = state.redPlayer === me ? 'R' : (state.yellowPlayer === me ? 'Y' : null);
    const isMyTurn = mySymbol && state.turn === mySymbol && !state.winner && data.status === 'active';
    const winningSet = new Set((state.winningLine || []).map(([c, r]) => `${c},${r}`));

    // Build a 7-column × 6-row grid. Top row = row index 5 (visual top).
    const cells = [];
    // Top row of drop buttons (so the user clicks a column header to drop).
    for (let c = 0; c < 7; c++) {
        const colFull = state.cols[c].length >= 6;
        cells.push(`
            <button class="c4-drop" data-col="${c}"
                    ${!isMyTurn || colFull ? 'disabled' : ''}
                    title="Drop in column ${c + 1}">▼</button>
        `);
    }
    // Then the 6 visual rows top-down.
    for (let r = 5; r >= 0; r--) {
        for (let c = 0; c < 7; c++) {
            const v = state.cols[c][r];
            const winCls = winningSet.has(`${c},${r}`) ? ' c4-cell-winning' : '';
            const colorCls = v === 'R' ? ' c4-cell-r' : (v === 'Y' ? ' c4-cell-y' : '');
            cells.push(`<div class="c4-cell${colorCls}${winCls}"></div>`);
        }
    }

    board.innerHTML = `
        <div class="c4-wrap">
            <div class="c4-grid">${cells.join('')}</div>
            <div class="c4-legend">
                You are <strong class="c4-${mySymbol === 'R' ? 'r' : 'y'}">${mySymbol === 'R' ? 'Red' : (mySymbol === 'Y' ? 'Yellow' : 'Spectator')}</strong> ·
                <span class="c4-r">Red: ${escapeHtml(state.redPlayer)}</span> ·
                <span class="c4-y">Yellow: ${escapeHtml(state.yellowPlayer)}</span>
            </div>
        </div>
    `;

    board.querySelectorAll('.c4-drop').forEach(btn => {
        btn.addEventListener('click', () => {
            const col = parseInt(btn.getAttribute('data-col'), 10);
            if (Number.isNaN(col)) return;
            socket.send(JSON.stringify({
                type: 'game_move', gameId, move: { col },
            }));
        });
    });

    if (state.winner) {
        // handleGameOver paints final chip.
    } else if (isMyTurn) {
        setGameStatusChip(gameId, `Your turn (${mySymbol === 'R' ? 'Red' : 'Yellow'})`);
    } else if (mySymbol) {
        const opp = state.turn === 'R' ? state.redPlayer : state.yellowPlayer;
        setGameStatusChip(gameId, `Waiting for ${opp}…`);
    } else {
        setGameStatusChip(gameId, 'Spectating');
    }
};

// ---------------------------------------------------------------------------
// Hangman renderer (Phase 4.1)
// ---------------------------------------------------------------------------

// Classic ASCII gallows revealed piece-by-piece per wrong guess.
const HANGMAN_FRAMES = [
    // 0 wrong — empty gallows
    `  +---+
  |   |
      |
      |
      |
      |
=========`,
    // 1 wrong — head
    `  +---+
  |   |
  O   |
      |
      |
      |
=========`,
    // 2 wrong — body
    `  +---+
  |   |
  O   |
  |   |
      |
      |
=========`,
    // 3 wrong — left arm
    `  +---+
  |   |
  O   |
 /|   |
      |
      |
=========`,
    // 4 wrong — right arm
    `  +---+
  |   |
  O   |
 /|\\  |
      |
      |
=========`,
    // 5 wrong — left leg
    `  +---+
  |   |
  O   |
 /|\\  |
 /    |
      |
=========`,
    // 6 wrong — right leg (dead)
    `  +---+
  |   |
  O   |
 /|\\  |
 / \\  |
      |
=========`,
];

AIM_GAME_RENDERERS.hangman = function renderHangmanBoard(gameId, state, data) {
    const win = aimOpenGameWindows.get(gameId);
    if (!win) return;
    const board = win.querySelector('.game-board');
    if (!board) return;

    const me = userInfo.nickname;
    const isPicker  = me === state.picker;
    const isGuesser = me === state.guesser;
    const isOver = state.phase === 'over' || data.status === 'over';

    if (state.phase === 'awaiting_word') {
        if (isPicker) {
            board.innerHTML = `
                <div class="hangman-wrap">
                    <h3 class="hangman-title">Pick a word for ${escapeHtml(state.guesser)}</h3>
                    <p class="hangman-help">Letters, spaces, hyphens, apostrophes only.</p>
                    <input type="text" class="win95-input hangman-word-input" maxlength="32" autocomplete="off">
                    <button class="win95-button hangman-submit-word">Submit Word</button>
                    <div class="form-error hangman-error"></div>
                </div>
            `;
            const input = board.querySelector('.hangman-word-input');
            const err = board.querySelector('.hangman-error');
            const submit = () => {
                const w = input.value.trim();
                if (!/^[a-zA-Z][a-zA-Z\s'\-]{1,30}$/.test(w)) {
                    err.textContent = 'Letters, spaces, hyphens, or apostrophes only (2–31 chars).';
                    return;
                }
                socket.send(JSON.stringify({
                    type: 'game_move', gameId, move: { word: w },
                }));
            };
            board.querySelector('.hangman-submit-word').addEventListener('click', submit);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
            setTimeout(() => input.focus(), 50);
            setGameStatusChip(gameId, 'Pick a word');
        } else {
            board.innerHTML = `
                <div class="hangman-wrap">
                    <h3 class="hangman-title">Waiting for ${escapeHtml(state.picker)}</h3>
                    <p class="hangman-help">They're picking a word for you to guess…</p>
                </div>
            `;
            setGameStatusChip(gameId, `Waiting for ${state.picker}…`);
        }
        return;
    }

    const wrong = state.wrong || [];
    const correct = state.correct || [];
    const frame = HANGMAN_FRAMES[Math.min(wrong.length, HANGMAN_FRAMES.length - 1)];

    // Alphabet keyboard. Only enabled for guesser during guessing phase.
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const keys = letters.map(l => {
        const used = correct.includes(l) || wrong.includes(l);
        const cls = used
            ? (correct.includes(l) ? ' hangman-key-correct' : ' hangman-key-wrong')
            : '';
        return `<button class="hangman-key${cls}" data-letter="${l}" ${used || !isGuesser || isOver ? 'disabled' : ''}>${l.toUpperCase()}</button>`;
    }).join('');

    // The word the picker sees vs. the masked view for the guesser.
    const displayWord = isOver
        ? (state.word || state.mask)
        : (isPicker ? state.word : state.mask);

    board.innerHTML = `
        <div class="hangman-wrap">
            <pre class="hangman-gallows">${frame}</pre>
            <div class="hangman-word-display">${[...(displayWord || '')].map(ch =>
                `<span class="hangman-char ${ch === '_' ? 'hangman-char-hidden' : ''}">${ch === ' ' ? ' ' : escapeHtml(ch)}</span>`
            ).join('')}</div>
            <div class="hangman-meta">
                <div>Wrong: ${wrong.length}/${state.maxWrong} ·
                    <span class="hangman-wrong-list">${wrong.map(l => escapeHtml(l.toUpperCase())).join(' ')}</span>
                </div>
            </div>
            <div class="hangman-keyboard">${keys}</div>
            ${isPicker && !isOver ? `<div class="hangman-picker-note">Your word: <strong>${escapeHtml(state.word)}</strong></div>` : ''}
        </div>
    `;

    board.querySelectorAll('.hangman-key:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            const letter = btn.getAttribute('data-letter');
            socket.send(JSON.stringify({
                type: 'game_move', gameId, move: { letter },
            }));
        });
    });

    // Status chip
    if (isOver) {
        // handleGameOver paints chip.
    } else if (isGuesser) {
        setGameStatusChip(gameId, `Your guess (${wrong.length}/${state.maxWrong} wrong)`);
    } else {
        setGameStatusChip(gameId, `${state.guesser} is guessing…`);
    }
};

function handleGameChat(data) {
    appendGameChatLine(data.gameId, data.from, data.message);
}

function handleGameError(data) {
    // Phase 1: most likely "game type not yet implemented". Show as a soft
    // Coming Soon dialog rather than an alert so the vibe stays right.
    const reason = data.reason || 'Something went wrong.';
    const isComingSoon = /not yet implemented|not playable yet/i.test(reason);
    showInfoDialog({
        title: isComingSoon ? 'Coming Soon!' : 'Game Error',
        message: isComingSoon
            ? `That game isn\'t ready to play yet — the Phase 1 plumbing is in place, but the board lands in Phase 2.<br><br><i>${escapeHtml(reason)}</i>`
            : escapeHtml(reason),
    });
    if (!isComingSoon) playSound('error-sound');
    // If the game window opened first, close it — no game to play.
    const win = aimOpenGameWindows.get(data.gameId);
    if (win) {
        setTimeout(() => {
            win.style.display = 'none';
            aimOpenGameWindows.delete(data.gameId);
            win.remove();
        }, 200);
    }
}