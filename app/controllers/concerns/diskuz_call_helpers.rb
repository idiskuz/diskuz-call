# frozen_string_literal: true

module DiskuzCallHelpers
  def self.diskuz_call_user_enabled?(user)
    return false if user.blank?
    return false unless SiteSetting.diskuz_call_enabled?

    raw = SiteSetting.diskuz_call_allowed_groups
    allowed_ids = case raw
                 when Array
                   raw.map(&:to_i).reject(&:zero?)
                 when String
                   s = raw.strip
                   return true if s.blank?
                   return true if s.casecmp("all").zero?
                   s.split(%r{[|,]}).map(&:to_i).reject(&:zero?)
                 else
                   return true if raw.blank?
                   []
                 end
    return true if allowed_ids.empty?

    user_group_ids = user_group_ids_for(user)
    (user_group_ids & allowed_ids).any?
  end

  def self.user_group_ids_for(user)
    return [] if user.blank?
    if user.respond_to?(:group_ids) && user.group_ids.respond_to?(:to_a)
      user.group_ids.to_a
    elsif user.respond_to?(:groups)
      user.groups.pluck(:id) rescue []
    else
      []
    end
  end

  # "Loro mi seguono": il target segue il caller (così il caller può chiamare il target).
  def self.target_follows_caller?(target_user, caller_user)
    return true if target_user.blank? || caller_user.blank?
    return true unless SiteSetting.respond_to?(:discourse_follow_enabled?) && SiteSetting.discourse_follow_enabled?
    return true unless target_user.respond_to?(:following)

    relation = target_user.following
    return true unless relation

    if relation.respond_to?(:where)
      relation.where(id: caller_user.id).exists?
    elsif relation.respond_to?(:include?)
      relation.include?(caller_user)
    else
      true
    end
  rescue StandardError => e
    Rails.logger.warn("diskuz-call: target_follows_caller error (allowing call): #{e.message}")
    true
  end

  # "Ci si segue a vicenda": target segue caller E caller segue target (opzionale per user card).
  def self.mutual_follow?(target_user, caller_user)
    return true if target_user.blank? || caller_user.blank?
    return true unless SiteSetting.respond_to?(:discourse_follow_enabled?) && SiteSetting.discourse_follow_enabled?
    return false unless target_user.respond_to?(:following) && caller_user.respond_to?(:following)

    target_user.following.where(id: caller_user.id).exists? &&
      caller_user.following.where(id: target_user.id).exists?
  end

  private

  def diskuz_call_user_enabled?(user)
    DiskuzCallHelpers.diskuz_call_user_enabled?(user)
  end

  # Se discourse-follow è attivo: il destinatario deve seguire il chiamante (così il chiamante vede "Call" solo per chi lo segue).
  def target_follows_current_user?(target)
    DiskuzCallHelpers.target_follows_caller?(target, current_user)
  end
end
