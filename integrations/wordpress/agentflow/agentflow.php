<?php
/**
 * Plugin Name:       AgentFlow Assistant
 * Description:       Adds your AgentFlow AI assistant to this site as a chat bubble or inline panel, and signs in logged-in WordPress users so the assistant can recognise them.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            AgentFlow
 * License:           GPL-2.0-or-later
 * Text Domain:       agentflow
 */

if (!defined('ABSPATH')) {
    exit;
}

const AGENTFLOW_OPTION = 'agentflow_settings';

/** Saved settings with defaults. */
function agentflow_settings(): array
{
    $defaults = [
        'api_url' => 'http://localhost:4000',
        'widget_key' => '',
        'mode' => 'bubble',
        'identity_secret' => '',
        'identify_users' => '1',
    ];
    $saved = get_option(AGENTFLOW_OPTION, []);
    return array_merge($defaults, is_array($saved) ? $saved : []);
}

// --- Settings page --------------------------------------------------------------------------

add_action('admin_menu', function () {
    add_options_page('AgentFlow Assistant', 'AgentFlow', 'manage_options', 'agentflow', 'agentflow_render_settings');
});

add_action('admin_init', function () {
    register_setting('agentflow', AGENTFLOW_OPTION, [
        'type' => 'array',
        'sanitize_callback' => function ($input) {
            $current = agentflow_settings();
            $out = [
                'api_url' => esc_url_raw(rtrim(trim($input['api_url'] ?? ''), '/')),
                'widget_key' => sanitize_text_field($input['widget_key'] ?? ''),
                'mode' => in_array($input['mode'] ?? '', ['bubble', 'none'], true) ? $input['mode'] : 'bubble',
                'identify_users' => empty($input['identify_users']) ? '0' : '1',
                // An empty field keeps the stored secret, so it is never echoed back into the page.
                'identity_secret' => trim($input['identity_secret'] ?? '') !== ''
                    ? sanitize_text_field($input['identity_secret'])
                    : $current['identity_secret'],
            ];
            if (!empty($input['clear_identity_secret'])) {
                $out['identity_secret'] = '';
            }
            return $out;
        },
    ]);
});

function agentflow_render_settings()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    $s = agentflow_settings();
    ?>
    <div class="wrap">
        <h1>AgentFlow Assistant</h1>
        <p>Copy these values from the flow's <strong>Deploy</strong> page in AgentFlow.</p>
        <form method="post" action="options.php">
            <?php settings_fields('agentflow'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="agentflow_api_url">AgentFlow API URL</label></th>
                    <td><input name="<?php echo esc_attr(AGENTFLOW_OPTION); ?>[api_url]" id="agentflow_api_url" type="url" class="regular-text" value="<?php echo esc_attr($s['api_url']); ?>" placeholder="https://api.example.com" /></td>
                </tr>
                <tr>
                    <th scope="row"><label for="agentflow_widget_key">Widget key</label></th>
                    <td>
                        <input name="<?php echo esc_attr(AGENTFLOW_OPTION); ?>[widget_key]" id="agentflow_widget_key" type="text" class="regular-text code" value="<?php echo esc_attr($s['widget_key']); ?>" placeholder="wk_…" />
                        <p class="description">The <code>data-flow</code> value in the embed snippet. Add this site's address (for example <code><?php echo esc_html(home_url()); ?></code>) to the flow's allowed websites.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row">Show as</th>
                    <td>
                        <label><input type="radio" name="<?php echo esc_attr(AGENTFLOW_OPTION); ?>[mode]" value="bubble" <?php checked($s['mode'], 'bubble'); ?> /> Chat bubble on every page</label><br />
                        <label><input type="radio" name="<?php echo esc_attr(AGENTFLOW_OPTION); ?>[mode]" value="none" <?php checked($s['mode'], 'none'); ?> /> Only where I place the <code>[agentflow]</code> shortcode</label>
                    </td>
                </tr>
                <tr>
                    <th scope="row">Signed-in users</th>
                    <td>
                        <label><input type="checkbox" name="<?php echo esc_attr(AGENTFLOW_OPTION); ?>[identify_users]" value="1" <?php checked($s['identify_users'], '1'); ?> /> Tell the assistant who logged-in users are (id, name, email)</label>
                        <p class="description">Lets flows greet customers by name and use long-term memory. Needs the identity secret below.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="agentflow_identity_secret">Identity secret</label></th>
                    <td>
                        <input name="<?php echo esc_attr(AGENTFLOW_OPTION); ?>[identity_secret]" id="agentflow_identity_secret" type="password" class="regular-text" value="" autocomplete="new-password" placeholder="<?php echo $s['identity_secret'] ? '•••••••• (saved)' : 'Paste the secret from the Deploy page'; ?>" />
                        <?php if ($s['identity_secret']) : ?>
                            <label><input type="checkbox" name="<?php echo esc_attr(AGENTFLOW_OPTION); ?>[clear_identity_secret]" value="1" /> Remove saved secret</label>
                        <?php endif; ?>
                        <p class="description">Created under "Signed-in users" on the Deploy page. It never leaves this server.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
        <h2>Inline panel</h2>
        <p>Place <code>[agentflow height="600"]</code> in any page or post to show the assistant inside the content.</p>
    </div>
    <?php
}

// --- Identity token (HS256 JWT) ----------------------------------------------------------------

function agentflow_b64url(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

/** A short-lived token naming the logged-in user, verified by AgentFlow with the identity secret. */
function agentflow_identity_token(): ?string
{
    $s = agentflow_settings();
    if ($s['identify_users'] !== '1' || $s['identity_secret'] === '' || !is_user_logged_in()) {
        return null;
    }
    $user = wp_get_current_user();
    $header = ['alg' => 'HS256', 'typ' => 'JWT'];
    $now = time();
    $claims = [
        'sub' => 'wp_' . $user->ID,
        'name' => $user->display_name,
        'email' => $user->user_email,
        'roles' => array_values($user->roles),
        'iat' => $now,
        'exp' => $now + HOUR_IN_SECONDS,
    ];
    $unsigned = agentflow_b64url(wp_json_encode($header)) . '.' . agentflow_b64url(wp_json_encode($claims));
    $signature = hash_hmac('sha256', $unsigned, $s['identity_secret'], true);
    return $unsigned . '.' . agentflow_b64url($signature);
}

// --- Front end ----------------------------------------------------------------------------------

/** Script tag for the widget, plus an inline call that signs the user in once the widget is ready. */
function agentflow_script_tag(string $mode, string $target = ''): string
{
    $s = agentflow_settings();
    if ($s['widget_key'] === '' || $s['api_url'] === '') {
        return '';
    }
    $attrs = sprintf(
        'src="%s" data-flow="%s" data-mode="%s"%s async',
        esc_url($s['api_url'] . '/widget.js'),
        esc_attr($s['widget_key']),
        esc_attr($mode),
        $target !== '' ? ' data-target="' . esc_attr($target) . '"' : ''
    );
    $html = "<script {$attrs}></script>\n";
    $token = agentflow_identity_token();
    if ($token) {
        $html .= '<script>(function(t){var n=0;(function w(){if(window.AgentFlow){window.AgentFlow.identify(t);}else if(n++<100){setTimeout(w,100);}})();})('
            . wp_json_encode($token) . ");</script>\n";
    }
    return $html;
}

add_action('wp_footer', function () {
    $s = agentflow_settings();
    if ($s['mode'] === 'bubble') {
        echo agentflow_script_tag('bubble'); // phpcs:ignore WordPress.Security.EscapeOutput -- escaped in agentflow_script_tag
    }
});

add_shortcode('agentflow', function ($atts) {
    static $count = 0;
    $count++;
    $atts = shortcode_atts(['height' => '600'], $atts, 'agentflow');
    $id = 'agentflow-inline-' . $count;
    $height = max(200, (int) $atts['height']);
    return sprintf('<div id="%s" style="height:%dpx"></div>', esc_attr($id), $height) . agentflow_script_tag('inline', '#' . $id);
});

/** Settings link on the Plugins screen. */
add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    array_unshift($links, '<a href="' . esc_url(admin_url('options-general.php?page=agentflow')) . '">Settings</a>');
    return $links;
});
