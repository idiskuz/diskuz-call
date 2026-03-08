# frozen_string_literal: true

# name: diskuz-call
# about: P2P voice calls (WebRTC) with built-in UI. One plugin, no theme component. Signaling via MessageBus; admin can restrict by group and set incoming call sound.
# version: 0.3.0-beta
# authors: diskuz.com, Cristian Deraco
# url: https://github.com/idiskuz/diskuz-call

enabled_site_setting :diskuz_call_enabled

# I file in assets/javascripts sono inclusi automaticamente nei bundle (Discourse 2026+). Non usare register_asset per JS.
register_asset "stylesheets/common/diskuz-call.scss"

# Variabile CSS colore principale (iniettata in :root per sovrascrivere il default nello SCSS)
if respond_to?(:register_html_builder)
  register_html_builder(:head) do
    primary = SiteSetting.diskuz_call_primary_color.presence || "#13c98c"
    primary = "#13c98c" unless primary.to_s.match?(/\A#[0-9a-fA-F]{6}\z/)
    hex = primary.to_s.strip.sub(/\A#/, "")
    dark = if hex.length == 6
      r = (hex[0..1].to_i(16) * 0.72).round.clamp(0, 255)
      g = (hex[2..3].to_i(16) * 0.72).round.clamp(0, 255)
      b = (hex[4..5].to_i(16) * 0.72).round.clamp(0, 255)
      format("#%02x%02x%02x", r, g, b)
    else
      "#0f8f6a"
    end
    "<style data-discourse-plugin=\"diskuz-call\">:root{--diskuz-call-primary:#{primary};--diskuz-call-primary-dark:#{dark};}</style>".html_safe
  end
end

after_initialize do
  require_relative "app/controllers/concerns/diskuz_call_helpers"
  require_relative "app/controllers/diskuz_call_controller"
  require_relative "app/controllers/diskuz_call_signal_controller"

  begin
    if User.respond_to?(:register_custom_field_type)
      User.register_custom_field_type("diskuz_call_enabled", :boolean)
      User.register_custom_field_type("diskuz_call_selected_custom_ringtone_index", :integer)
    end
  rescue NameError, ArgumentError, StandardError => e
    Rails.logger.warn("diskuz-call: skip register_custom_field_type: #{e.message}")
  end

  Discourse::Application.routes.append do
    get "diskuz-call/status" => "diskuz_call#status"
    put "diskuz-call/preferences" => "diskuz_call#preferences"
    get "diskuz-call/can-call/:user_id" => "diskuz_call#can_call"
    post "diskuz-call/signal" => "diskuz_call_signal#send_signal"
    get "diskuz-call/watermark.png" => "diskuz_call#watermark"
  end
end
