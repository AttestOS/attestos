<?php
/**
 * Plugin Name: AttestOS - Free Zero-Cost CAPTCHA Replacement & Bot Protection
 * Plugin URI: https://attestos.dev
 * Description: High-performance, zero-puzzle, GDPR-compliant bot protection powered by client-side Proof-of-Work and Hardware Attestation. Kills spam without annoying puzzles.
 * Version: 2.0.0
 * Author: AttestOS Team
 * Author URI: https://attestos.dev
 * License: GPL-2.0+
 * Text Domain: attestos
 */

if (!defined('ABSPATH')) {
    exit;
}

class AttestOS_Plugin {
    private static $instance = null;
    private $options;

    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        $this->options = get_option('attestos_settings', array(
            'site_key' => 'wp_default_' . substr(md5(get_bloginfo('url')), 0, 8),
            'protect_login' => 1,
            'protect_comments' => 1,
            'protect_register' => 1,
            'protect_woocommerce' => 1
        ));

        add_action('wp_enqueue_scripts', array($this, 'enqueue_assets'));
        add_action('login_enqueue_scripts', array($this, 'enqueue_assets'));

        // Forms Hooks
        if (!empty($this->options['protect_login'])) {
            add_action('login_form', array($this, 'render_widget'));
            add_filter('authenticate', array($this, 'validate_login'), 30, 3);
        }

        if (!empty($this->options['protect_comments'])) {
            add_action('comment_form_after_fields', array($this, 'render_widget'));
            add_filter('preprocess_comment', array($this, 'validate_comment'));
        }

        if (!empty($this->options['protect_register'])) {
            add_action('register_form', array($this, 'render_widget'));
            add_filter('registration_errors', array($this, 'validate_registration'), 10, 3);
        }

        // Admin Settings Menu
        if (is_admin()) {
            add_action('admin_menu', array($this, 'add_admin_menu'));
            add_action('admin_init', array($this, 'register_settings'));
        }
    }

    public function enqueue_assets() {
        wp_enqueue_script(
            'attestos-client',
            'https://cdn.attestos.dev/attestos.js',
            array(),
            '2.0.0',
            true
        );
    }

    public function render_widget() {
        $site_key = esc_attr($this->options['site_key']);
        echo '<div class="attestos-widget" data-sitekey="' . $site_key . '" style="margin: 12px 0;"></div>';
    }

    public function validate_login($user, $username, $password) {
        if (empty($username)) return $user;
        // Don't block WP-CLI, XML-RPC, REST API or Cron
        if (defined('XMLRPC_REQUEST') || defined('REST_REQUEST') || (defined('DOING_CRON') && DOING_CRON)) {
            return $user;
        }
        if (!$this->verify_submission()) {
            return new WP_Error('attestos_failed', __('<strong>ERROR</strong>: Bot verification failed. Please ensure JavaScript is enabled.', 'attestos'));
        }
        return $user;
    }

    public function validate_comment($commentdata) {
        if (defined('XMLRPC_REQUEST') || defined('REST_REQUEST')) {
            return $commentdata;
        }
        if (!is_user_logged_in() && !$this->verify_submission()) {
            wp_die(__('Verification failed: AttestOS detected automated activity.', 'attestos'));
        }
        return $commentdata;
    }

    public function validate_registration($errors, $sanitized_user_login, $user_email) {
        if (!$this->verify_submission()) {
            $errors->add('attestos_failed', __('Bot verification failed. Please try again.', 'attestos'));
        }
        return $errors;
    }

    private function verify_submission() {
        if (empty($_POST['attestos_payload'])) {
            return false;
        }

        $payload_raw = wp_unslash($_POST['attestos_payload']);
        $payload = json_decode($payload_raw, true);
        if (!$payload || empty($payload['powSolution'])) {
            return false;
        }

        $pow = $payload['powSolution'];
        $salt = sanitize_text_field($pow['salt'] ?? '');
        $nonce = sanitize_text_field($pow['nonce'] ?? '');
        $diff = intval($pow['difficulty'] ?? 4);

        // Security baseline: Reject tampered difficulty less than 4
        if ($diff < 4) {
            return false;
        }

        if (empty($salt) || empty($nonce)) return false;

        // Verify SHA-256 math directly in PHP (zero third-party latency!)
        $hash = hash('sha256', $salt . $nonce);
        $target = str_repeat('0', $diff);

        return (strpos($hash, $target) === 0);
    }

    public function add_admin_menu() {
        add_options_page('AttestOS Protection', 'AttestOS', 'manage_options', 'attestos', array($this, 'render_admin_page'));
    }

    public function register_settings() {
        register_setting('attestos_settings_group', 'attestos_settings');
    }

    public function render_admin_page() {
        ?>
        <div class="wrap">
            <h1>🛡️ AttestOS Bot Protection Settings</h1>
            <p>High-performance, zero-puzzle CAPTCHA alternative powered by client-side Proof-of-Work and Hardware Attestation.</p>
            <form method="post" action="options.php">
                <?php
                settings_fields('attestos_settings_group');
                ?>
                <table class="form-table">
                    <tr>
                        <th scope="row">Site Key</th>
                        <td><input type="text" name="attestos_settings[site_key]" value="<?php echo esc_attr($this->options['site_key']); ?>" class="regular-text" /></td>
                    </tr>
                    <tr>
                        <th scope="row">Protected Forms</th>
                        <td>
                            <label><input type="checkbox" name="attestos_settings[protect_login]" value="1" <?php checked(1, $this->options['protect_login']); ?> /> Protect Login Form</label><br>
                            <label><input type="checkbox" name="attestos_settings[protect_register]" value="1" <?php checked(1, $this->options['protect_register']); ?> /> Protect Registration Form</label><br>
                            <label><input type="checkbox" name="attestos_settings[protect_comments]" value="1" <?php checked(1, $this->options['protect_comments']); ?> /> Protect Comments</label>
                        </td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:16px;border-radius:8px;margin-top:20px;max-width:600px;">
                <h4 style="margin:0 0 8px 0;color:#166534;">Upgrade to AttestOS Enterprise Mesh via Whop</h4>
                <p style="margin:0 0 12px 0;font-size:13px;color:#15803d;">Need Chrome DevTools Protocol (CDP) anti-stealth unmasking and silent Apple Secure Enclave attestation?</p>
                <a href="https://whop.com/checkout/plan_attestos_enterprise" target="_blank" class="button button-primary">Upgrade on Whop</a>
            </div>
        </div>
        <?php
    }
}

add_action('plugins_loaded', array('AttestOS_Plugin', 'get_instance'));
