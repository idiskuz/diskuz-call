# frozen_string_literal: true

# name: diskuz-call
# about: P2P voice calls (WebRTC) with built-in UI. One plugin, no theme component. Signaling via MessageBus; admin can restrict by group and set incoming call sound.
# version: 0.3.0-beta
# authors: diskuz.com, Cristian Deraco
# url: https://github.com/idiskuz/diskuz-call

enabled_site_setting :diskuz_call_enabled

# I file in assets/javascripts sono inclusi automaticamente nei bundle (Discourse 2026+). Non usare register_asset per JS.
register_asset "stylesheets/common/diskuz-call.scss"


after_initialize do
  require_relative "app/controllers/concerns/diskuz_call_helpers"
  require_relative "app/controllers/diskuz_call_controller"
  require_relative "app/controllers/diskuz_call_signal_controller"

  begin
    if User.respond_to?(:register_custom_field_type)
      User.register_custom_field_type("diskuz_call_enabled", :boolean)
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
