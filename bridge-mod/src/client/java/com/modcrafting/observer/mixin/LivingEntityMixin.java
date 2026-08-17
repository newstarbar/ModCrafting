package com.modcrafting.observer.mixin;

import com.modcrafting.observer.ObservationTrace;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.damage.DamageSource;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Records authoritative death attribution for the integrated test world. */
@Mixin(LivingEntity.class)
public class LivingEntityMixin {
    @Inject(method = "onDeath", at = @At("TAIL"), require = 0)
    private void modcrafting$recordDeath(DamageSource source, CallbackInfo ci) {
        LivingEntity victim = (LivingEntity) (Object) this;
        ObservationTrace.combatDeath(victim, source == null ? null : source.getAttacker(), source == null ? null : source.getType().msgId());
    }
}
