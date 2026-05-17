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
        profileWindow.style.width = '400px';
        profileWindow.style.height = '450px';
        profileWindow.style.top = '100px';
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
                            <label>Status:</label>
                            <div class="status-options">
                                <label class="status-option">
                                    <input type="radio" name="status" value="online" ${userProfile.status === 'online' ? 'checked' : ''}>
                                    <span class="status-dot online"></span>
                                    Online
                                </label>
                                <label class="status-option">
                                    <input type="radio" name="status" value="offline" ${userProfile.status === 'offline' ? 'checked' : ''}>
                                    <span class="status-dot offline"></span>
                                    Offline
                                </label>
                            </div>
                        </div>
                    </div>
                    
                    <div class="profile-section">
                        <h3 class="section-title">Notification Settings</h3>
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
                    
                    <div class="profile-actions">
                        <button class="win95-button" id="profile-save-button">Save Changes</button>
                        <button class="win95-button" id="profile-cancel-button">Cancel</button>
                    </div>
                </div>
            </div>
        `;
        
        document.querySelector('.win95-container').appendChild(profileWindow);
        makeWindowsDraggable();
        
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
            const status = profileWindow.querySelector('input[name="status"]:checked').value;
            const soundEnabled = profileWindow.querySelector('#profile-sound-enabled').checked;
            const typingIndicator = profileWindow.querySelector('#profile-typing-indicator').checked;
            
            // Save profile
            saveUserProfile({
                displayName,
                bio,
                avatarColor,
                status,
                soundEnabled,
                typingIndicator
            });
            
            // Update UI
            updateProfileUI();
            
            // Show confirmation message
            alert('Profile updated successfully!');
        });
        
        // Set up cancel button
        profileWindow.querySelector('#profile-cancel-button').addEventListener('click', () => {
            profileWindow.style.display = 'none';
        });
    } else {
        profileWindow.style.display = 'block';
    }
    
    showWindow('profile-window');
}

function getUserProfile() {
    // Try to get profile from localStorage
    const storedProfile = localStorage.getItem('userProfile');
    
    if (storedProfile) {
        return JSON.parse(storedProfile);
    }
    
    // Return default profile if not found
    return {
        displayName: userInfo.nickname,
        bio: 'I love chatting in Windows 95 style!',
        avatarColor: '#007BFF',
        status: 'online',
        soundEnabled: true,
        typingIndicator: true
    };
}

function saveUserProfile(profile) {
    localStorage.setItem('userProfile', JSON.stringify(profile));
    
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
    if (oldActiveNow && oldActiveNow.style.display === 'block') {
        oldActiveNow.remove();
        showActiveNowWindow();
    }
}

// Auto-refresh interval for active users list
let activeUsersRefreshInterval = null;
const REFRESH_INTERVAL = 10000; // 10 seconds

function showActiveNowWindow() {
    let activeNowWindow = document.getElementById('active-now-window');
    
    if (!activeNowWindow) {
        // Create the Active Now window
        activeNowWindow = document.createElement('div');
        activeNowWindow.id = 'active-now-window';
        activeNowWindow.className = 'window';
        activeNowWindow.style.width = '300px';
        activeNowWindow.style.height = '400px';
        activeNowWindow.style.top = '120px';
        activeNowWindow.style.left = '200px';
        
        activeNowWindow.innerHTML = `
            <div class="window-header">
                <div class="window-title">Buddy List</div>
                <div class="window-controls">
                    <button class="control-button minimize">-</button>
                    <button class="control-button maximize">□</button>
                    <button class="control-button close">×</button>
                </div>
            </div>
            <div class="window-content">
                <div class="active-users-controls">
                    <button class="win95-button refresh-users-btn">Refresh</button>
                    <span class="auto-refresh-status">Auto-refresh: ON</span>
                </div>
                <div class="active-users-list" id="active-users-list">
                    <div class="loading">Loading buddy list...</div>
                </div>
            </div>
        `;
        
        document.querySelector('.win95-container').appendChild(activeNowWindow);
        makeWindowsDraggable();
        
        // Add event listener for refresh button
        activeNowWindow.querySelector('.refresh-users-btn').addEventListener('click', fetchActiveUsers);
        
        // Set up event listener for window close to clear auto-refresh
        activeNowWindow.querySelector('.control-button.close').addEventListener('click', () => {
            if (activeUsersRefreshInterval) {
                clearInterval(activeUsersRefreshInterval);
                activeUsersRefreshInterval = null;
            }
        });
    } else {
        activeNowWindow.style.display = 'block';
    }
    
    showWindow('active-now-window');
    
    // Fetch active users from server immediately
    fetchActiveUsers();
    
    // Set up auto-refresh timer
    if (activeUsersRefreshInterval) {
        clearInterval(activeUsersRefreshInterval);
    }
    
    activeUsersRefreshInterval = setInterval(() => {
        if (activeNowWindow.style.display !== 'none') {
            fetchActiveUsers();
        }
    }, REFRESH_INTERVAL);
}

// ---------- Buddy list (local) ----------
// AIM-style "buddies" are stored client-side in localStorage, keyed by the
// signed-in user's nickname so different accounts on the same browser keep
// separate lists. This avoids adding a backend schema for an optional UI
// affordance.
function buddyStorageKey() {
    const me = (typeof userInfo !== 'undefined' && userInfo.nickname) ? userInfo.nickname : 'anon';
    return 'aim_buddies_' + me;
}
function getBuddies() {
    try {
        const raw = localStorage.getItem(buddyStorageKey());
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}
function setBuddies(list) {
    try { localStorage.setItem(buddyStorageKey(), JSON.stringify(list)); } catch (_) {}
}
function isBuddy(nick) { return getBuddies().includes(nick); }
function addBuddy(nick) {
    const b = getBuddies();
    if (!b.includes(nick)) { b.push(nick); setBuddies(b); }
}
function removeBuddyEntry(nick) {
    setBuddies(getBuddies().filter(n => n !== nick));
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
    } else {
        removeBuddyEntry(nick);
        playSound('buddyout-sound');
    }
    updateActiveUsersList(lastUsersSnapshot);
};

// Keep track of known users for detecting new users
let knownUsers = [];

function fetchActiveUsers() {
    console.log('Fetching active users...');
    const activeUsersList = document.querySelector('#active-now-window .active-users-list');
    if (!activeUsersList) {
        console.error('Active users list element not found');
        return;
    }
    
    // Only show loading state on first load, not during refreshes
    if (activeUsersList.innerHTML === '' || activeUsersList.innerHTML.includes('Loading buddy list')) {
        activeUsersList.innerHTML = '<div class="loading">Loading buddy list...</div>';
    }
    
    // Fetch active users from the server
    fetch('backend.php?endpoint=active-users')
        .then(response => {
            console.log('Active users response status:', response.status);
            return response.text().then(text => {
                console.log('Active users raw response:', text);
                try {
                    return JSON.parse(text);
                } catch (e) {
                    console.error('Invalid JSON in response:', text);
                    throw new Error('Invalid server response');
                }
            });
        })
        .then(data => {
            console.log('Active users response data:', data);
            if (data.success) {
                // Check for new users
                const currentUsers = data.users.map(user => user.nickname);
                const newUsers = currentUsers.filter(user => !knownUsers.includes(user));
                
                // Update known users list
                knownUsers = currentUsers;
                
                // Update the UI
                updateActiveUsersList(data.users);
                
                // Update the counter in the desktop icon
                const userCount = document.querySelector('#active-users-icon .user-count');
                if (userCount) {
                    userCount.textContent = data.users.length;
                }
                
                // Notify about new users (except for the current user's first login)
                if (newUsers.length > 0) {
                    newUsers.forEach(user => {
                        if (user !== userInfo.nickname) {
                            console.log(`New user detected: ${user}`);
                            // Show a system notification in all open chat rooms
                            document.querySelectorAll('.chat-window').forEach(window => {
                                if (window.id !== 'chat-window-template' && window.style.display !== 'none') {
                                    const roomId = window.dataset.roomId;
                                    if (roomId) {
                                        addSystemMessage(roomId, `${user} has joined the chat app`);
                                    }
                                }
                            });
                        }
                    });
                }
            } else {
                console.error('Failed to load active users:', data.error);
                activeUsersList.innerHTML = '<div class="loading error">Failed to load buddy list</div>';
            }
        })
        .catch(error => {
            console.error('Error fetching active users:', error);
            activeUsersList.innerHTML = '<div class="loading error">Failed to load buddy list</div>';
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

    // Sort: current user pinned to the top, then buddies (alphabetical),
    // then everyone else (alphabetical). Mirrors classic AIM behavior.
    const sorted = users.slice().sort((a, b) => {
        if (a.nickname === userInfo.nickname) return -1;
        if (b.nickname === userInfo.nickname) return 1;
        const aB = buddies.includes(a.nickname);
        const bB = buddies.includes(b.nickname);
        if (aB !== bB) return aB ? -1 : 1;
        return a.nickname.localeCompare(b.nickname);
    });

    activeUsersList.innerHTML = sorted.map(user => {
        const isCurrentUser = user.nickname === userInfo.nickname;
        const isBud = buddies.includes(user.nickname);
        const displayName = isCurrentUser ? userProfile.displayName : user.nickname;
        const avatarColor = isCurrentUser ? userProfile.avatarColor : (user.avatarColor || '#007BFF');
        const status = isCurrentUser ? userProfile.status : (user.status || 'online');
        const safeNick = escapeHtml(user.nickname);

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

        return `
            <div class="active-user-item${isBud ? ' is-buddy' : ''}${isCurrentUser ? ' is-self' : ''}">
                <div class="user-avatar" style="background-color: ${avatarColor}">
                    ${displayName.charAt(0).toUpperCase()}
                    <div class="user-status ${status}"></div>
                </div>
                <div class="user-info">
                    <div class="user-name">${escapeHtml(displayName)}${isCurrentUser ? ' (You)' : ''}</div>
                    <div class="user-status-text">${isBud ? 'Buddy' : (status === 'offline' ? 'Offline' : 'Online')}</div>
                </div>
                ${buddyToggle}
                ${!isCurrentUser ? `
                    <button class="win95-button message-button" onclick="showDirectMessageWindow('${safeNick}')">
                        Message
                    </button>
                ` : ''}
            </div>
        `;
    }).join('');
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
        
        const sendDirectMessage = () => {
            const message = messageInput.value.trim();
            if (message && socket && socket.readyState === WebSocket.OPEN) {
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
        
        // Request message history from the server
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'get_direct_messages',
                with: recipient
            }));
        }
    }
    
    showWindow(windowId);
}

function handleIncomingDirectMessage(data) {
    const { from, message, timestamp } = data;
    
    console.log('Received direct message from:', from);
    
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
        addDirectMessage(from, from, message, new Date(timestamp), false);
        
        // Play sound notification
        const profile = getUserProfile();
        if (profile.soundEnabled) {
            playSound('chat-sound');
        }
    } else {
        console.error('Failed to create or find DM window for:', from);
    }
}

function addDirectMessage(recipient, sender, message, timestamp, isSent) {
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
    messageElement.className = `message ${isSent ? 'sent' : 'received'}`;
    
    const timeStr = formatMessageTime(timestamp);
    
    messageElement.innerHTML = `
        <div class="message-header">
            <span class="message-sender">${sender}:</span>
            <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-content">${escapeHtml(message)}</div>
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

    // Initialize user list in the background immediately
    // This will make users visible faster when the Active Now window is opened
    setTimeout(() => {
        fetchActiveUsers();
        
        // Set up periodic background refresh for active users
        setInterval(() => {
            fetchActiveUsers();
        }, 15000); // Every 15 seconds
    }, 500);
    
    // Initialize chatrooms icon click handler
    const chatroomsIcon = document.getElementById('chatrooms-icon');
    if (chatroomsIcon) {
        chatroomsIcon.addEventListener('click', () => {
            const chatroomsWindow = document.getElementById('chatrooms-window');
            if (chatroomsWindow) {
                chatroomsWindow.style.display = 'block';
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
            createRoomDialog.style.display = 'block';
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
    window.style.display = 'block';
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
                window.style.display = 'block';
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
                        <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAHlJREFUOE/tk8sNwCAMQ5mBDbJR2YQdWKDhU6mcohapPXHII1HiOKE55zxCCA/4zjnf931TnrsjhICc87vKzAIiAvfVdX4JiJmRUkLrFbJqALoMgoDWGlprWw2q6kO01qi1Ys4528A9KZPYj6QfKH6TOvH7PPj8gesNnXdJbzL2K3IHAAAAAElFTkSuQmCC" class="room-icon">
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
        chatWindow.style.display = 'block';
        
        // Set window position slightly offset from previous windows
        const offset = document.querySelectorAll('.chat-window').length * 20;
        chatWindow.style.top = `${100 + offset}px`;
        chatWindow.style.left = `${100 + offset}px`;
        
        // Set room title
        chatWindow.querySelector('.window-title').textContent = `Chat: ${room.name} (${userInfo.nickname})`;
        
        // Add event listener for sending messages
        const messageInput = chatWindow.querySelector('.message-input');
        const sendButton = chatWindow.querySelector('.send-button');
        
        const sendMessage = () => {
            const message = messageInput.value.trim();
            if (message) {
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
        chatWindow.style.display = 'block';
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
            <span class="message-sender">${nickname}:</span>
            <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-content">${escapeHtml(message)}</div>
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
    const host = window.WS_HOST || 'aim-chat-56ce9127edbc.herokuapp.com';
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
                        for (const nick of current) {
                            if (!rosterSnapshot.has(nick) && nick !== userInfo.nickname) {
                                playSound('buddyin-sound');
                                break; // one chime per update is plenty
                            }
                        }
                        for (const nick of rosterSnapshot) {
                            if (!current.has(nick) && nick !== userInfo.nickname) {
                                playSound('buddyout-sound');
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
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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