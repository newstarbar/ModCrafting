package com.modcrafting.observer.mixin;

import com.modcrafting.observer.ObservationTrace;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.render.entity.EntityRenderDispatcher;
import net.minecraft.client.render.entity.EntityRenderer;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Records the selected renderer for every rendered entity without changing rendering. */
@Mixin(EntityRenderDispatcher.class)
public class EntityRenderDispatcherMixin {
    @Inject(
            method = "render(Lnet/minecraft/entity/Entity;DDDFLnet/minecraft/client/util/math/MatrixStack;Lnet/minecraft/client/render/VertexConsumerProvider;I)V",
            at = @At("HEAD"),
            require = 0
    )
    private void modcrafting$recordRenderer(Entity entity, double x, double y, double z, float tickDelta, MatrixStack matrices, VertexConsumerProvider consumers, int light, CallbackInfo ci) {
        EntityRenderer<?, ?> renderer = ((EntityRenderDispatcher) (Object) this).getRenderer(entity);
        ObservationTrace.render(entity, renderer);
    }
}
